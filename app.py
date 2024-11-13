import logging
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse, RedirectResponse
import requests
from collections import Counter, defaultdict
from typing import Set, Dict, List, Optional
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor
import time
from dataclasses import dataclass
import redis
import json
import asyncio
from sse_starlette.sse import EventSourceResponse
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from threading import Lock
import uuid
import os
from typing import TypedDict

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

logger = logging.getLogger("bluesky_analyzer")

# Configuration class for type safety
class RedisConfig(TypedDict):
    host: str
    port: int
    db: int

# Constants
RATE_LIMIT = 3000
MAX_WORKERS = 40
CACHE_TTL = 3600*6
STREAM_INTERVAL = 5

# Redis configuration with environment variable support
REDIS_CONFIG: RedisConfig = {
    'host': os.getenv('REDIS_HOST', 'localhost'),
    'port': int(os.getenv('REDIS_PORT', '6379')),
    'db': int(os.getenv('REDIS_DB', '0'))
}

# Log the Redis configuration at startup
logger.info(f"Redis configuration: {REDIS_CONFIG}")

class UserAnalysisState:
    def __init__(self, session_id: str, handle: str):
        self.session_id = session_id
        self.handle = handle
        self.follows_of_follows = Counter()
        self.your_follows: Set[str] = set()
        self.processed_handles: Set[str] = set()
        self.lock = Lock()
        self.is_running = False
        self.last_access = time.time()
        
    def update_follows(self, handle: str, follows: Set[str]):
        with self.lock:
            self.follows_of_follows.update(follows)
            self.processed_handles.add(handle)
            self.last_access = time.time()

    def get_results(self) -> List[Dict]:
        with self.lock:
            self.last_access = time.time()
            # First get the filtered and sliced results without follower counts
            results = [
                {"handle": handle, "count": count}
                for handle, count in self.follows_of_follows.most_common()
                if handle not in self.your_follows and count > 5 and handle != "handle.invalid"
            ][:1000]
            
            # Now enrich with follower counts using BlueskyAPI
            api = BlueskyAPI()
            with ThreadPoolExecutor(max_workers=10) as executor:
                futures = {
                    executor.submit(api.get_follower_count, result["handle"]): result
                    for result in results
                }
                
                for future in concurrent.futures.as_completed(futures):
                    result = futures[future]
                    try:
                        follower_count = future.result()
                        result["followers"] = follower_count
                    except Exception as e:
                        logger.error(f"Error getting follower count for {result['handle']}: {e}")
                        result["followers"] = 0
           
            return results


class AnalysisStateManager:
    def __init__(self):
        self.states: Dict[str, UserAnalysisState] = {}
        self.lock = Lock()
        self.cleanup_task = None
        self.cleanup_interval = 3600
    
    async def start(self):
        """Start the cleanup task"""
        if self.cleanup_task is None:
            self.cleanup_task = asyncio.create_task(self._cleanup_old_sessions())
    
    async def stop(self):
        """Stop the cleanup task"""
        if self.cleanup_task:
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
            self.cleanup_task = None
    
    def create_session(self, handle: str) -> str:
        session_id = str(uuid.uuid4())
        with self.lock:
            self.states[session_id] = UserAnalysisState(session_id, handle)
        return session_id
    
    def get_state(self, session_id: str) -> Optional[UserAnalysisState]:
        with self.lock:
            return self.states.get(session_id)
    
    def remove_session(self, session_id: str):
        with self.lock:
            if session_id in self.states:
                self.states[session_id].is_running = False
                del self.states[session_id]
    
    async def _cleanup_old_sessions(self):
        while True:
            try:
                await asyncio.sleep(self.cleanup_interval)
                current_time = time.time()
                with self.lock:
                    expired_sessions = [
                        sid for sid, state in self.states.items()
                        if current_time - state.last_access > self.cleanup_interval
                    ]
                    for sid in expired_sessions:
                        self.remove_session(sid)
            except asyncio.CancelledError:
                break

# Create the state manager instance
state_manager = AnalysisStateManager()

app = FastAPI(title="Bluesky Network Analysis")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add startup and shutdown events for the state manager
@app.on_event("startup")
async def startup_event():
    logger.info("Starting up state manager...")
    await state_manager.start()

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down state manager...")
    await state_manager.stop()

@dataclass
class RateLimiter:
    calls_per_second: int
    last_call_time: float = 0

    def wait(self):
        current_time = time.time()
        time_since_last_call = current_time - self.last_call_time
        time_needed = 1.0 / self.calls_per_second
        
        if time_since_last_call < time_needed:
            time.sleep(time_needed - time_since_last_call)
        
        self.last_call_time = time.time()


class BlueskyAPI:
    def __init__(self):
        self.rate_limiter = RateLimiter(RATE_LIMIT)
        self.session = requests.Session()
        try:
            self.redis = redis.Redis(**REDIS_CONFIG, decode_responses=True)
            self.redis.ping()
            logger.info("Successfully connected to Redis")
        except redis.ConnectionError as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise

    def _get_cache_key(self, actor: str) -> str:
        return f"cbluesky:follows:{actor}"

    def _get_follower_count_cache_key(self, actor: str) -> str:
        return f"bcluesky:followers:{actor}"

    def get_follows(self, actor: str, limit: int = 100, cursor: Optional[str] = None) -> Dict:
        self.rate_limiter.wait()
        
        url = "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows"
        params = {"actor": actor, "limit": limit}
        if cursor:
            params["cursor"] = cursor
            
        response = self.session.get(url, params=params)
        if response.status_code != 200:
            logger.error(f"Error fetching follows for {actor}: {response.text}")
            return {"follows": []}
        return response.json()

    def get_follower_count(self, actor: str) -> int:
        """Get follower count for an actor, using cache if available"""
        # Check cache first
        cache_key = self._get_follower_count_cache_key(actor)
        cached_count = self.redis.get(cache_key)
        if cached_count is not None:
            return int(cached_count)

        # If not in cache, fetch from API
        self.rate_limiter.wait()
        url = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile"
        params = {"actor": actor}
        
        try:
            response = self.session.get(url, params=params)
            if response.status_code == 200:
                follower_count = response.json().get('followersCount', 0)
                # Cache the result
                self.redis.setex(cache_key, CACHE_TTL, str(follower_count))
                return follower_count
        except Exception as e:
            logger.error(f"Error fetching profile for {actor}: {e}")
        
        return 0

    def _fetch_all_follows(self, actor: str) -> Set[str]:
        """Internal method to fetch all follows for an actor from the API."""
        follows = set()
        cursor = None

        while True:
            try:
                response = self.get_follows(actor, cursor=cursor)
                new_follows = set(follow['handle'] for follow in response['follows'])
                follows.update(new_follows)
                
                if 'cursor' not in response:
                    break
                cursor = response['cursor']
            except requests.exceptions.RequestException:
                logger.error(f"Error fetching follows for {actor}")
                break

        return follows

    def get_all_follows(self, actor: str, use_cache: bool = True) -> Set[str]:
        """Get all follows for an actor."""
        cache_key = self._get_cache_key(actor)
        if use_cache:
            cached_follows = self.redis.get(cache_key)
            if cached_follows:
                return set(json.loads(cached_follows))
            logger.info(f"Cache miss for {actor}")

        follows = self._fetch_all_follows(actor)
    
        if follows:
            self.redis.setex(cache_key, CACHE_TTL, json.dumps(list(follows)))
        else:
            logger.info(f"No follows found for {actor}")
            self.redis.setex(cache_key, CACHE_TTL, "[]")

        return follows

async def continuous_analysis(session_id: str):
    """Continuously analyze follows for a specific user session"""
    state = state_manager.get_state(session_id)
    if not state:
        logger.error(f"No state found for session {session_id}")
        return

    api = BlueskyAPI()
    state.is_running = True
    
    try:
        # Get initial follows
        your_follows = api.get_all_follows(state.handle, False)
        if not your_follows:
            logger.error(f"No follows found for {state.handle}")
            return
        state.your_follows = your_follows
        
        while state.is_running:
            # Get a batch of unprocessed follows
            unprocessed = your_follows - state.processed_handles

            
            # Process a small batch
            batch = set(list(unprocessed)[:10])
            
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                futures = {
                    executor.submit(api.get_all_follows, h): h
                    for h in batch
                }
                
                for future in concurrent.futures.as_completed(futures):
                    handle = futures[future]
                    try:
                        their_follows = future.result()
                        state.update_follows(handle, their_follows)
                    except Exception as e:
                        logger.error(f"Error processing {handle}: {e}")
            
            await asyncio.sleep(0.1)
            
    except Exception as e:
        logger.error(f"Error in continuous analysis for session {session_id}: {e}")
    finally:
        state.is_running = False

async def follow_analyzer_event_generator(handle: str):
    # Create new session
    session_id = state_manager.create_session(handle)
    logger.info(f"Created new session {session_id} for handle {handle}")
    
    # Start continuous analysis in background
    asyncio.create_task(continuous_analysis(session_id))
    
    try:
        while True:
            state = state_manager.get_state(session_id)
            if not state:
                break
                
            results = state.get_results()
            
            yield {
                "event": "update",
                "data": json.dumps({
                    "results": results,
                    "timestamp": time.time(),
                    "processed_count": len(state.processed_handles),
                    "total_count": len(state.your_follows)
                })
            }
            
            await asyncio.sleep(STREAM_INTERVAL)
            
            if not state.is_running:
                break
                
    except Exception as e:
        logger.error(f"Error in event generator for session {session_id}: {e}")
        yield {
            "event": "error",
            "data": json.dumps({"error": str(e)})
        }
    finally:
        # Cleanup when connection closes
        state_manager.remove_session(session_id)
        logger.info(f"Removed session {session_id}")

@app.get("/")
async def home(request: Request):
    # redirect to https://bsky-follow-finder.theo.io/
    return RedirectResponse(url="https://bsky-follow-finder.theo.io/")
    
@app.get("/analyze/{handle}")
async def analyze_stream(handle: str):
    return EventSourceResponse(
        follow_analyzer_event_generator(handle)
    )




if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
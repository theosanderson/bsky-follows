import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, User, Lock, EyeOff, Eye, LockOpen, ExternalLink } from 'lucide-react';
import { PiButterflyFill } from "react-icons/pi";
import { BskyAgent } from '@atproto/api';
import { Toaster, toast } from 'react-hot-toast';

// Cache configuration
const CACHE_TTL = 3600 * 12 * 1000; // 12 hours in milliseconds
const CACHE_PREFIX = 'bsky_follows_';
const FOLLOWER_CACHE_PREFIX = 'bsky_followers_';

// Rate limiting configuration - be conservative for browser
const REQUESTS_PER_SECOND = 8;
const REQUEST_INTERVAL = 1000 / REQUESTS_PER_SECOND;

// Analysis configuration
const MIN_COMMON_FOLLOWS = 5;
const MAX_RESULTS = 1500;
const DISPLAY_RESULTS = 200; // Limit displayed results for performance
const CONCURRENT_REQUESTS = 4;
const UPDATE_INTERVAL_MS = 5000; // Update UI every 5 seconds

// Simple rate limiter
class RateLimiter {
  constructor(requestsPerSecond) {
    this.minInterval = 1000 / requestsPerSecond;
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
  }

  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;

      if (timeSinceLastRequest < this.minInterval) {
        await new Promise(r => setTimeout(r, this.minInterval - timeSinceLastRequest));
      }

      this.lastRequestTime = Date.now();
      const resolve = this.queue.shift();
      resolve();
    }

    this.processing = false;
  }
}

// LocalStorage cache helpers
const getFromCache = (key) => {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;

    const { data, timestamp } = JSON.parse(item);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

const setInCache = (key, data) => {
  try {
    localStorage.setItem(key, JSON.stringify({
      data,
      timestamp: Date.now()
    }));
  } catch (e) {
    // localStorage might be full, try to clear old entries
    console.warn('Cache write failed:', e);
  }
};

// Bluesky API client for browser
class BlueskyBrowserAPI {
  constructor() {
    this.rateLimiter = new RateLimiter(REQUESTS_PER_SECOND);
  }

  async getFollows(actor, limit = 100, cursor = null) {
    await this.rateLimiter.acquire();

    const params = new URLSearchParams({ actor, limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?${params}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch follows for ${actor}: ${response.status}`);
    }

    return response.json();
  }

  async getAllFollows(actor, useCache = true) {
    const cacheKey = `${CACHE_PREFIX}${actor}`;

    if (useCache) {
      const cached = getFromCache(cacheKey);
      if (cached) {
        return new Set(cached);
      }
    }

    const follows = new Set();
    let cursor = null;

    try {
      while (true) {
        const response = await this.getFollows(actor, 100, cursor);

        for (const follow of response.follows || []) {
          follows.add(follow.handle);
        }

        if (!response.cursor) break;
        cursor = response.cursor;
      }

      // Cache the results
      setInCache(cacheKey, Array.from(follows));
    } catch (error) {
      console.error(`Error fetching follows for ${actor}:`, error);
    }

    return follows;
  }

  async getFollowerCount(actor) {
    const cacheKey = `${FOLLOWER_CACHE_PREFIX}${actor}`;
    const cached = getFromCache(cacheKey);
    if (cached !== null) {
      return cached;
    }

    await this.rateLimiter.acquire();

    try {
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${actor}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!response.ok) return 0;

      const data = await response.json();
      const count = data.followersCount || 0;
      setInCache(cacheKey, count);
      return count;
    } catch {
      return 0;
    }
  }
}

const WeightToggle = ({ weighted, onToggle }) => {
  return (
    <div className="flex items-center gap-4 mb-4">
      <div className="flex items-center">
        <input
          type="radio"
          id="unweighted"
          name="weight-mode"
          value="unweighted"
          checked={!weighted}
          onChange={() => onToggle(false)}
          className="w-4 h-4 text-sky-600 border-gray-300 focus:ring-sky-500"
        />
        <label htmlFor="unweighted" className="ml-2 text-sm text-gray-500">
          Sort by total (favours larger accounts)
        </label>
      </div>

      <div className="flex items-center">
        <input
          type="radio"
          id="weighted"
          name="weight-mode"
          value="weighted"
          checked={weighted}
          onChange={() => onToggle(true)}
          className="w-4 h-4 text-sky-600 border-gray-300 focus:ring-sky-500"
        />
        <label htmlFor="weighted" className="ml-2 text-sm text-gray-500">
          Sort by proportion (favours niche accounts)
        </label>
      </div>
    </div>
  );
};

const calculateWilsonScore = (positive, total, confidence = 0.95) => {
  if (total === 0) return 0;

  const z = 1.96;
  const phat = positive / total;
  const z2 = z * z;
  const n = total;

  const numerator = phat + z2/(2*n) - z * Math.sqrt((phat*(1-phat) + z2/(4*n))/n);
  const denominator = 1 + z2/n;

  return numerator/denominator;
};

const profileCache = new Map();
const pendingRequests = new Map();

const FollowButton = ({ handle, appPassword, username, className = "" }) => {
  const [isFollowing, setIsFollowing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  if (handle === username) return null;
  if (!appPassword) return null;

  const handleFollowAction = async () => {
    if (isLoading || !appPassword || !username) return;

    setIsLoading(true);
    try {
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      await agent.login({ identifier: username, password: appPassword });

      const { data } = await agent.getProfile({ actor: handle });
      const { did } = data;

      if (!isFollowing) {
        await agent.follow(did);
        setIsFollowing(true);
      } else {
        await agent.deleteFollow(did);
        setIsFollowing(false);
      }
    } catch (error) {
      console.error('Follow action failed:', error);
      toast.error('Failed to follow. Maybe the app password is wrong? Or we may have exceeded the Bluesky rate limit for following. ' + error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <button
      onClick={handleFollowAction}
      disabled={isLoading}
      className={`px-3 py-1 text-sm rounded-full transition-colors ${
        isLoading
          ? 'bg-gray-100 text-gray-400'
          : isFollowing
          ? 'bg-sky-100 text-sky-700 hover:bg-sky-200'
          : 'bg-sky-500 text-white hover:bg-sky-600'
      } ${className}`}
    >
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : isFollowing ? (
        'Following'
      ) : (
        'Follow'
      )}
    </button>
  );
};

const useBlueskyProfiles = () => {
  const [profiles, setProfiles] = useState({});

  const fetchProfile = useCallback(async (handle) => {
    if (profileCache.has(handle)) {
      return profileCache.get(handle);
    }

    if (pendingRequests.has(handle)) {
      return pendingRequests.get(handle);
    }

    const requestPromise = (async () => {
      try {
        const response = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${handle}`,
          { headers: { 'Accept': 'application/json' } }
        );

        if (!response.ok) throw new Error('Profile fetch failed');

        const data = await response.json();
        profileCache.set(handle, data);
        pendingRequests.delete(handle);
        return data;
      } catch (error) {
        console.error(`Error fetching profile for ${handle}:`, error);
        pendingRequests.delete(handle);
        return null;
      }
    })();

    pendingRequests.set(handle, requestPromise);

    const profile = await requestPromise;
    if (profile) {
      setProfiles(prev => ({ ...prev, [handle]: profile }));
    }

    return profile;
  }, []);

  return { profiles, fetchProfile };
};

const ResultItem = ({ item, index, onInView, handleToAnalyze, appPassword, weightedEnabled }) => {
  const itemRef = useRef(null);

  useEffect(() => {
    const viewObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onInView(item.handle);
            viewObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '50% 0px 50% 0px' }
    );

    if (itemRef.current) {
      viewObserver.observe(itemRef.current);
    }

    return () => {
      if (itemRef.current) {
        viewObserver.unobserve(itemRef.current);
      }
    };
  }, [item.handle, onInView]);

  const getBskyUrl = (handle) => `https://bsky.app/profile/${handle}`;

  return (
    <div
      ref={itemRef}
      className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-gray-50 transition-colors"
    >
      <span className="text-sky-800 text-sm font-mono w-6 flex-shrink-0">
        {index + 1}
      </span>
      <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-100 flex-shrink-0">
        {item.profile?.avatar ? (
          <img
            src={item.profile.avatar}
            alt={item.profile.displayName || item.handle}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-sky-100">
            <User className="w-6 h-6 text-sky-500" />
          </div>
        )}
      </div>
      <div className="flex flex-1 justify-between items-start gap-2 min-w-0">
        <div className="flex flex-col min-w-0 max-w-32 md:max-w-none">
          <div className="flex items-center gap-2">
            <a
              href={getBskyUrl(item.handle)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-900 hover:text-sky-800 hover:underline truncate"
            >
              {item.profile?.displayName || item.handle}
              {item.handle === handleToAnalyze && (
                <span className="text-xs text-sky-500 ml-1">(You)</span>
              )}
            </a>
            <FollowButton
              appPassword={appPassword}
              handle={item.handle}
              username={handleToAnalyze}
              className="ml-2"
            />
          </div>
          <span className="text-sm text-sky-700 truncate">
            @{window.innerWidth < 640 && item.handle.includes('bsky.social')
              ? item.handle.split('.')[0]
              : item.handle}
          </span>
          {item.profile?.description && (
            <p className="text-xs text-sky-600 mt-1 line-clamp-2" title={item.profile.description}>
              {item.profile.description}
            </p>
          )}
        </div>
        <div className="text-right flex-shrink-0 text-sky-800">
          <span className="text-sm font-medium">
            {item.count}
            {weightedEnabled && item.followers > 0 && <span>/{item.followers}</span>}
          </span>
          <span className="text-xs block">follows</span>
        </div>
      </div>
    </div>
  );
};

// Browser-based analysis hook
const useBrowserAnalysis = () => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const abortRef = useRef(false);
  const apiRef = useRef(null);

  const analyze = useCallback(async (handle) => {
    abortRef.current = false;
    setIsAnalyzing(true);
    setResults([]);
    setError(null);
    setProgress({ processed: 0, total: 0 });

    if (!apiRef.current) {
      apiRef.current = new BlueskyBrowserAPI();
    }
    const api = apiRef.current;

    try {
      // Step 1: Get the user's follows (don't use cache for this to get fresh data)
      const userFollows = await api.getAllFollows(handle, false);

      if (userFollows.size === 0) {
        setError('No follows found for this user. Check the handle is correct.');
        setIsAnalyzing(false);
        return;
      }

      setProgress({ processed: 0, total: userFollows.size });

      // Step 2: For each follow, get their follows and count
      const followsOfFollows = new Map(); // handle -> count
      const followsArray = Array.from(userFollows);
      let processed = 0;

      // Process in batches for better performance
      const processBatch = async (batch) => {
        const promises = batch.map(async (followHandle) => {
          if (abortRef.current) return;

          try {
            const theirFollows = await api.getAllFollows(followHandle, true);
            return { handle: followHandle, follows: theirFollows };
          } catch (err) {
            console.error(`Error fetching follows for ${followHandle}:`, err);
            return { handle: followHandle, follows: new Set() };
          }
        });

        const results = await Promise.all(promises);

        for (const { follows } of results) {
          if (abortRef.current) return;

          for (const h of follows) {
            followsOfFollows.set(h, (followsOfFollows.get(h) || 0) + 1);
          }
        }
      };

      // Cache for follower counts we've already fetched
      const followerCounts = new Map();

      // Helper to get top results with follower counts
      const getTopResults = () => {
        return Array.from(followsOfFollows.entries())
          .filter(([h, count]) =>
            !userFollows.has(h) &&
            count > MIN_COMMON_FOLLOWS &&
            h !== 'handle.invalid' &&
            h !== handle
          )
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_RESULTS)
          .map(([h, count]) => ({
            handle: h,
            count,
            followers: followerCounts.get(h) || 0
          }));
      };

      // Process in concurrent batches
      let lastUpdateTime = Date.now();

      for (let i = 0; i < followsArray.length; i += CONCURRENT_REQUESTS) {
        if (abortRef.current) break;

        const batch = followsArray.slice(i, i + CONCURRENT_REQUESTS);
        await processBatch(batch);
        processed += batch.length;

        setProgress({ processed, total: userFollows.size });

        // Generate intermediate results every 5 seconds or at the end
        const now = Date.now();
        if (now - lastUpdateTime >= UPDATE_INTERVAL_MS || processed === userFollows.size) {
          lastUpdateTime = now;
          const currentTop = getTopResults();

          // Fetch follower counts for top results that we don't have yet (limit to top 50 for speed)
          const needFollowerCounts = currentTop
            .slice(0, 50)
            .filter(r => !followerCounts.has(r.handle));

          if (needFollowerCounts.length > 0) {
            const counts = await Promise.all(
              needFollowerCounts.map(async (r) => {
                const followers = await api.getFollowerCount(r.handle);
                return { handle: r.handle, followers };
              })
            );
            counts.forEach(({ handle, followers }) => {
              followerCounts.set(handle, followers);
            });
          }

          setResults(getTopResults());
        }
      }

      if (abortRef.current) return;

      // Final pass: ensure all results have follower counts
      const finalResults = getTopResults();
      const remaining = finalResults.filter(r => !followerCounts.has(r.handle));

      for (let i = 0; i < remaining.length; i += 10) {
        if (abortRef.current) break;

        const batch = remaining.slice(i, i + 10);
        const counts = await Promise.all(
          batch.map(async (r) => {
            const followers = await api.getFollowerCount(r.handle);
            return { handle: r.handle, followers };
          })
        );
        counts.forEach(({ handle, followers }) => {
          followerCounts.set(handle, followers);
        });
        setResults(getTopResults());
      }

      setIsAnalyzing(false);
    } catch (err) {
      console.error('Analysis error:', err);
      setError(`Analysis failed: ${err.message}`);
      setIsAnalyzing(false);
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current = true;
    setIsAnalyzing(false);
  }, []);

  return { analyze, abort, isAnalyzing, progress, results, error };
};

// Main component
const BlueskyAnalyzer = () => {
  const [inputValue, setInputValue] = useState('');
  const [handleToAnalyze, setHandleToAnalyze] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [showAppPasswordSection, setShowAppPasswordSection] = useState(false);
  const [weightedEnabled, setWeightedEnabled] = useState(false);

  const { analyze, abort, isAnalyzing, progress, results, error } = useBrowserAnalysis();
  const { profiles, fetchProfile } = useBlueskyProfiles();

  let enhancedResults = results.map(result => ({
    ...result,
    profile: profiles[result.handle]
  }));

  if (weightedEnabled) {
    enhancedResults = enhancedResults
      .map(result => ({
        ...result,
        score: calculateWilsonScore(result.count, result.followers)
      }))
      .sort((a, b) => b.score - a.score);
  }

  // Limit displayed results for performance
  const displayedResults = enhancedResults.slice(0, DISPLAY_RESULTS);

  const handleInView = useCallback((handle) => {
    fetchProfile(handle);
  }, [fetchProfile]);

  const handleSubmit = (e) => {
    e.preventDefault();
    let processedHandle = inputValue.trim();
    processedHandle = processedHandle.replace(/[^\x00-\x7F]/g, '');

    if (!processedHandle.includes('.')) {
      processedHandle = `${processedHandle}.bsky.social`;
    }

    if (processedHandle.startsWith('@')) {
      processedHandle = processedHandle.slice(1);
    }

    const finalHandle = processedHandle.toLowerCase();
    setHandleToAnalyze(finalHandle);
    analyze(finalHandle);
  };

  const handleCancel = () => {
    abort();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-white p-4 md:p-8">
      <Toaster />
      <div className="max-w-4xl mx-auto">
        <div className="md:flex items-center md:justify-between mb-8">
          <div className="md:flex items-center gap-3">
            <PiButterflyFill className="w-8 h-8 mb-3 md:mb-0 mx-auto md:mx-0 md:w-12 md:h-12 text-sky-600" />
            <h1 className="text-3xl font-bold mb-4 md:mb-0 bg-gradient-to-r from-sky-600 to-sky-600 text-transparent bg-clip-text">
              Bluesky network analyzer
            </h1>
          </div>
          <p className="text-sky-600 text-sm">
            made by{' '}
            <a
              href="https://bsky.app/profile/theo.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-500 hover:text-sky-700 hover:underline"
            >
              @theo.io
            </a>
          </p>
        </div>

        <p className="text-sky-700 mb-4 text-lg">
          Enter your Bluesky handle below to find people followed by lots of the people you follow (but not you).
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm text-amber-800">
          <strong>Browser-only version:</strong> This runs entirely in your browser. Analysis may take several minutes for accounts with many follows. Your data never leaves your device.
        </div>

        <div className="bg-white/80 backdrop-blur-sm rounded-lg shadow-lg shadow-sky-100/50 p-6 mb-4 border border-sky-100">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col md:flex-row gap-4">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Enter Bluesky handle (e.g., user.bsky.social)"
                className="flex-1 p-2 border border-sky-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white/90"
                disabled={isAnalyzing}
              />
              {isAnalyzing ? (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-red-500 text-white px-6 py-2 rounded-lg hover:bg-red-600 transition-colors shadow-sm hover:shadow-md"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="submit"
                  className="bg-sky-500 text-white px-6 py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-sm hover:shadow-md"
                >
                  Analyze
                </button>
              )}
            </div>

            {!showAppPasswordSection ? (
              (isAnalyzing || results.length > 0) && (
                <button
                  type="button"
                  onClick={() => setShowAppPasswordSection(true)}
                  className="text-sky-600 hover:text-sky-500 text-sm flex items-center gap-2 self-start"
                >
                  <LockOpen className="w-4 h-4" />
                  Add an app password to enable follow buttons (optional)
                </button>
              )
            ) : (
              <>
                <div className="flex flex-col md:flex-row gap-4 items-center">
                  <div className="relative flex-1">
                    <input
                      type={showAppPassword ? "text" : "password"}
                      value={appPassword}
                      onChange={(e) => setAppPassword(e.target.value)}
                      placeholder="Enter App Password to enable follow buttons"
                      className="w-full p-2 pr-10 border border-sky-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white/90"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAppPassword(!showAppPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-sky-500 hover:text-sky-600"
                    >
                      {showAppPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="text-sm text-sky-600 flex items-center gap-2">
                    <Lock className="w-4 h-4" />
                    Password is kept in local browser
                  </div>
                </div>
                <div className="block">
                  <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className="text-sky-500 hover:text-sky-600 text-sm hover:underline">
                    <ExternalLink className="w-4 h-4 inline-block mr-1" />
                    Go to Bluesky settings to create an app password
                  </a>
                </div>
              </>
            )}
          </form>
        </div>

        <div className="bg-white/80 backdrop-blur-sm rounded-lg shadow-lg shadow-sky-100/50 p-6 border border-sky-100">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sky-700">Results</h2>
            {progress.total > 0 && (
              <div className="text-sm text-sky-600 flex items-center">
                {isAnalyzing && progress.processed !== progress.total && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Processed {progress.processed}/{progress.total} follows
              </div>
            )}
          </div>

          {error ? (
            <div className="text-red-500 p-4 rounded-lg bg-red-50 border border-red-200">
              {error}
            </div>
          ) : results.length === 0 && isAnalyzing ? (
            <div className="text-sky-600 text-center py-8">
              <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin" />
              Initializing: finding the people you follow...
            </div>
          ) : (
            <div>
              {results.length > 0 && (
                <WeightToggle weighted={weightedEnabled} onToggle={setWeightedEnabled} />
              )}

              <div className="grid gap-3">
                {displayedResults.map((item, index) => (
                  <ResultItem
                    key={item.handle}
                    item={item}
                    index={index}
                    onInView={handleInView}
                    handleToAnalyze={handleToAnalyze}
                    appPassword={appPassword}
                    weightedEnabled={weightedEnabled}
                  />
                ))}

                {results.length > 0 && !isAnalyzing && (
                  <div className="text-center py-4 text-sky-600 text-sm">
                    Analysis complete! Showing top {displayedResults.length} of {results.length} suggestions.
                  </div>
                )}
              </div>
            </div>
          )}

          {appPassword && results.length > 0 && (
            <div className="mt-4 p-4 bg-sky-50 rounded-lg border border-sky-100">
              <div className="flex items-center gap-2 text-sky-700 text-sm">
                <Lock className="w-4 h-4" />
                <span>
                  Follow buttons are enabled. Click to follow/unfollow users directly.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BlueskyAnalyzer;

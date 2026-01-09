import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, User, Lock, EyeOff, Eye, LockOpen, ExternalLink } from 'lucide-react';
import { PiButterflyFill } from "react-icons/pi";
import { BskyAgent } from '@atproto/api';
import { Toaster, toast } from 'react-hot-toast';

// ============================================
// BROWSER-BASED BLUESKY NETWORK ANALYZER
// All analysis runs entirely in the browser
// ============================================

const BLUESKY_API = 'https://public.api.bsky.app/xrpc';

// Rate limiting: delay between API calls (in ms)
const API_DELAY = 50;

// Batch size for processing follows concurrently
const BATCH_SIZE = 5;

// Minimum count to show in results
const MIN_COUNT = 5;

// Maximum results to show
const MAX_RESULTS = 1500;

// Cache for follows (in-memory)
const followsCache = new Map();

// Helper to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch a single page of follows for an actor
async function fetchFollowsPage(actor, cursor = null) {
  const params = new URLSearchParams({ actor, limit: '100' });
  if (cursor) params.set('cursor', cursor);

  const response = await fetch(`${BLUESKY_API}/app.bsky.graph.getFollows?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch follows for ${actor}: ${response.status}`);
  }
  return response.json();
}

// Fetch all follows for an actor (handles pagination)
async function fetchAllFollows(actor, onProgress = null) {
  // Check cache first
  if (followsCache.has(actor)) {
    return followsCache.get(actor);
  }

  const follows = new Set();
  let cursor = null;
  let pageCount = 0;

  while (true) {
    try {
      await delay(API_DELAY);
      const data = await fetchFollowsPage(actor, cursor);

      for (const follow of data.follows || []) {
        follows.add(follow.handle);
      }

      pageCount++;
      if (onProgress) {
        onProgress(follows.size, pageCount);
      }

      if (!data.cursor) break;
      cursor = data.cursor;
    } catch (error) {
      console.error(`Error fetching follows for ${actor}:`, error);
      break;
    }
  }

  // Cache the result
  followsCache.set(actor, follows);
  return follows;
}

// Weight toggle component
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

// Wilson score calculation for weighted sorting
const calculateWilsonScore = (positive, total) => {
  if (total === 0) return 0;

  const z = 1.96; // z score for 95% confidence
  const phat = positive / total;
  const z2 = z * z;
  const n = total;

  const numerator = phat + z2/(2*n) - z * Math.sqrt((phat*(1-phat) + z2/(4*n))/n);
  const denominator = 1 + z2/n;

  return numerator/denominator;
};

// Profile cache
const profileCache = new Map();
const pendingRequests = new Map();

// Follow button component
const FollowButton = ({ handle, appPassword, username, className = "" }) => {
  const [isFollowing, setIsFollowing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  if (handle === username) {
    return null;
  }

  if (!appPassword) {
    return null;
  }

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

// Custom hook for fetching profiles
const useBlueskyProfiles = () => {
  const [profiles, setProfiles] = useState({});
  const [loadingHandles, setLoadingHandles] = useState(new Set());

  const fetchProfile = useCallback(async (handle) => {
    if (profileCache.has(handle)) {
      const cached = profileCache.get(handle);
      setProfiles(prev => ({ ...prev, [handle]: cached }));
      return cached;
    }

    if (pendingRequests.has(handle)) {
      return pendingRequests.get(handle);
    }

    setLoadingHandles(prev => new Set([...prev, handle]));

    const requestPromise = (async () => {
      try {
        const response = await fetch(`${BLUESKY_API}/app.bsky.actor.getProfile?actor=${handle}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) throw new Error('Profile fetch failed');

        const data = await response.json();
        profileCache.set(handle, data);
        pendingRequests.delete(handle);
        setLoadingHandles(prev => {
          const next = new Set(prev);
          next.delete(handle);
          return next;
        });
        return data;
      } catch (error) {
        console.error(`Error fetching profile for ${handle}:`, error);
        pendingRequests.delete(handle);
        setLoadingHandles(prev => {
          const next = new Set(prev);
          next.delete(handle);
          return next;
        });
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

  return { profiles, fetchProfile, loadingHandles };
};

// Result item component
const ResultItem = ({ item, index, onInView, handleToAnalyze, appPassword, weightedEnabled }) => {
  const itemRef = useRef(null);

  useEffect(() => {
    const viewObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onInView(item.handle);
            viewObserver.unobserve(entry.target);
            preloadObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    const preloadObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onInView(item.handle);
            preloadObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '50% 0px 50% 0px', threshold: 0 }
    );

    if (itemRef.current) {
      viewObserver.observe(itemRef.current);
      preloadObserver.observe(itemRef.current);
    }

    return () => {
      if (itemRef.current) {
        viewObserver.unobserve(itemRef.current);
        preloadObserver.unobserve(itemRef.current);
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
            {weightedEnabled && <span>/{item.followers}</span>}
          </span>
          <span className="text-xs block">follows</span>
        </div>
      </div>
    </div>
  );
};

// Main component
const BlueskyAnalyzer = () => {
  const [inputValue, setInputValue] = useState('');
  const [handleToAnalyze, setHandleToAnalyze] = useState('');
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ processed: 0, total: 0, status: '' });
  const [error, setError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [showAppPasswordSection, setShowAppPasswordSection] = useState(false);
  const [weightedEnabled, setWeightedEnabled] = useState(false);

  const abortControllerRef = useRef(null);

  const { profiles, fetchProfile } = useBlueskyProfiles();

  // Enhance results with profile data and optionally sort by Wilson score
  let enhancedResults = results.map(result => ({
    ...result,
    profile: profiles[result.handle]
  }));

  if (weightedEnabled) {
    enhancedResults = enhancedResults.map(result => ({
      ...result,
      score: calculateWilsonScore(result.count, result.followers)
    })).sort((a, b) => b.score - a.score);
  }

  const handleInView = useCallback((handle) => {
    fetchProfile(handle);
  }, [fetchProfile]);

  // Browser-based analysis function
  const analyzeNetwork = useCallback(async (handle) => {
    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();

    setIsAnalyzing(true);
    setResults([]);
    setError(null);
    setProgress({ processed: 0, total: 0, status: 'Finding your follows...' });

    try {
      // Step 1: Get the user's follows
      const yourFollows = await fetchAllFollows(handle, (count) => {
        setProgress({ processed: 0, total: 0, status: `Found ${count} follows...` });
      });

      if (yourFollows.size === 0) {
        setError('No follows found for this handle. Please check the username is correct.');
        setIsAnalyzing(false);
        return;
      }

      setProgress({ processed: 0, total: yourFollows.size, status: 'Analyzing network...' });

      // Step 2: For each follow, get their follows and aggregate
      const followsOfFollows = new Map(); // handle -> count
      const followsArray = Array.from(yourFollows);
      let processed = 0;

      // Process in batches
      for (let i = 0; i < followsArray.length; i += BATCH_SIZE) {
        // Check if cancelled
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const batch = followsArray.slice(i, i + BATCH_SIZE);

        // Process batch concurrently
        await Promise.all(batch.map(async (followHandle) => {
          try {
            const theirFollows = await fetchAllFollows(followHandle);

            // Update counts
            for (const h of theirFollows) {
              followsOfFollows.set(h, (followsOfFollows.get(h) || 0) + 1);
            }
          } catch (err) {
            console.error(`Error processing ${followHandle}:`, err);
          }

          processed++;

          // Update progress every few items
          if (processed % 3 === 0 || processed === followsArray.length) {
            setProgress({
              processed,
              total: followsArray.length,
              status: 'Analyzing network...'
            });

            // Update results periodically
            const currentResults = getFilteredResults(followsOfFollows, yourFollows);
            setResults(currentResults);
          }
        }));
      }

      // Final results
      const finalResults = getFilteredResults(followsOfFollows, yourFollows);
      setResults(finalResults);
      setProgress({ processed: followsArray.length, total: followsArray.length, status: 'Complete!' });

    } catch (err) {
      console.error('Analysis error:', err);
      setError('Something went wrong. Please try again. ' + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // Filter and sort results
  function getFilteredResults(followsOfFollows, yourFollows) {
    const results = [];

    for (const [handle, count] of followsOfFollows.entries()) {
      // Skip if it's someone you already follow, has low count, or is invalid
      if (yourFollows.has(handle) || count <= MIN_COUNT || handle === 'handle.invalid') {
        continue;
      }

      // Get follower count from profile cache if available
      const profile = profileCache.get(handle);
      const followers = profile?.followersCount || 0;

      results.push({ handle, count, followers });
    }

    // Sort by count descending and limit results
    results.sort((a, b) => b.count - a.count);
    return results.slice(0, MAX_RESULTS);
  }

  // Handle form submission
  const handleSubmit = (e) => {
    e.preventDefault();

    // Cancel any ongoing analysis
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    let processedHandle = inputValue.trim();
    processedHandle = processedHandle.replace(/[^\x00-\x7F]/g, '');

    if (!processedHandle.includes('.')) {
      processedHandle = `${processedHandle}.bsky.social`;
    }

    if (processedHandle.startsWith('@')) {
      processedHandle = processedHandle.slice(1);
    }

    setHandleToAnalyze(processedHandle.toLowerCase());
    analyzeNetwork(processedHandle.toLowerCase());
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

        <p className="text-sky-600 mb-4 text-sm">
          This version runs entirely in your browser - no data is sent to any server.
        </p>

        <div className="bg-white/80 backdrop-blur-sm rounded-lg shadow-lg shadow-sky-100/50 p-6 mb-4 border border-sky-100">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col md:flex-row gap-4">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Enter Bluesky handle (e.g., user.bsky.social)"
                className="flex-1 p-2 border border-sky-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white/90"
              />
              <button
                type="submit"
                disabled={isAnalyzing}
                className="bg-sky-500 text-white px-6 py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-sm hover:shadow-md disabled:opacity-50"
              >
                {isAnalyzing ? 'Analyzing...' : 'Analyze'}
              </button>
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
            {isAnalyzing && (
              <div className="text-sm text-sky-600 flex items-center">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {progress.total > 0
                  ? `Processed ${progress.processed}/${progress.total} follows`
                  : progress.status
                }
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
              {progress.status || 'Initializing: finding the people you follow...'}
            </div>
          ) : (
            <div>
              {results.length > 0 && (
                <WeightToggle weighted={weightedEnabled} onToggle={setWeightedEnabled} />
              )}

              <div className="grid gap-3">
                {enhancedResults.map((item, index) => (
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
                    Analysis complete! Found {results.length} suggestions.
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

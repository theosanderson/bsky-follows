import { useState, useEffect, useCallback } from 'react';
import { Loader2, User } from 'lucide-react';

// In-memory cache for profile data and pending requests
const profileCache = new Map();
const pendingRequests = new Map();

// Custom hook for Bluesky API calls with proper request deduplication
const useBlueskyProfiles = (handles) => {
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(false);

  const fetchProfile = useCallback(async (handle) => {
    // Check cache first
    if (profileCache.has(handle)) {
      return profileCache.get(handle);
    }

    // Check if there's already a pending request for this handle
    if (pendingRequests.has(handle)) {
      return pendingRequests.get(handle);
    }

    // Create new request promise
    const requestPromise = (async () => {
      try {
        const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${handle}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          }
        });
        
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

    // Store the pending request
    pendingRequests.set(handle, requestPromise);
    return requestPromise;
  }, []);

  useEffect(() => {
    let isMounted = true;
    
    const fetchProfiles = async () => {
      if (!handles.length) return;
      
      setLoading(true);
      const newProfiles = { ...profiles };
      
      // Process handles in batches of 5
      for (let i = 0; i < handles.length; i += 5) {
        if (!isMounted) break;
        
        const batch = handles.slice(i, i + 5);
        const batchPromises = batch.map(async (handle) => {
          if (!profiles[handle]) {
            const profile = await fetchProfile(handle);
            if (profile && isMounted) {
              newProfiles[handle] = profile;
            }
          }
        });

        await Promise.all(batchPromises);
        
        if (isMounted) {
          setProfiles(newProfiles);
        }
      }
      
      if (isMounted) {
        setLoading(false);
      }
    };

    fetchProfiles();

    return () => {
      isMounted = false;
    };
  }, [handles, fetchProfile]);

  // Debug logging to verify cache hits
  useEffect(() => {
    if (handles.length > 0) {
      console.log('Cache status:', {
        cacheSize: profileCache.size,
        pendingRequests: pendingRequests.size,
        cacheHits: handles.filter(h => profileCache.has(h)).length,
        pendingHits: handles.filter(h => pendingRequests.has(h)).length,
      });
    }
  }, [handles]);

  return { profiles, loading };
};
const BlueskyAnalyzer = () => {
  const [handle, setHandle] = useState('');
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [error, setError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  // Get profiles for results
  const { profiles, loading: loadingProfiles } = useBlueskyProfiles(
    results.map(r => r.handle)
  );

  useEffect(() => {
    let eventSource = null;

    const startAnalysis = () => {
      if (!handle.trim()) return;
      
      if (eventSource) {
        eventSource.close();
      }

      setIsAnalyzing(true);
      setResults([]);
      setError(null);

      eventSource = new EventSource(`//bsky-follow-suggestions.theo.io/analyze/${handle}`);

      eventSource.addEventListener('update', (e) => {
        try {
          const data = JSON.parse(e.data);
          setResults(data.results);
          setProgress({
            processed: data.processed_count,
            total: data.total_count
          });
        } catch (err) {
          setError('Failed to parse server data');
        }
      });

      eventSource.addEventListener('error', (e) => {
        setIsAnalyzing(false);
        try {
          const data = JSON.parse(e.data);
          setError(data.error);
        } catch (err) {
          setError('Connection error. Please try again.');
        }
        eventSource.close();
      });
    };

    if (isAnalyzing) {
      startAnalysis();
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [handle, isAnalyzing]);

  const handleSubmit = (e) => {
    e.preventDefault();
    let processedHandle = handle.trim();
    
    if (!processedHandle.includes('.')) {
      processedHandle = `${processedHandle}.bsky.social`;
    }
    
    if (processedHandle.startsWith('@')) {
      processedHandle = processedHandle.slice(1);
    }

    setHandle(processedHandle.toLowerCase());
    setIsAnalyzing(true);
  };

  const getBskyUrl = (handle) => `https://bsky.app/profile/${handle}`;

  return (
    <div className="min-h-screen bg-gray-100 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="md:flex items-center md:justify-between mb-8">
          <h1 className="text-3xl font-bold mb-4 md:mb-0">Bluesky Network Analyzer</h1>
          <p className="text-gray-500 text-sm">
            made by{' '}
            <a 
              href="https://bsky.app/profile/theo.io" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-blue-500 hover:underline"
            >
              @theo.io
            </a>
          </p>
        </div>

        <p className="text-gray-600 mb-4 text-lg">
          Enter your Bluesky handle below to find people followed by lots of the people you follow (but not you).
        </p>

        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <form onSubmit={handleSubmit} className="flex flex-col md:flex-row gap-4">
            <input 
              type="text" 
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="Enter Bluesky handle (e.g., user.bsky.social)" 
              className="flex-1 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button 
              type="submit"
              className="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 transition-colors"
            >
              Analyze
            </button>
          </form>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Results</h2>
            {isAnalyzing && progress.total > 0 && (
              <div className="text-sm text-gray-500 flex items-center">
                {progress.processed !== 0 && progress.processed !== progress.total &&
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                }
                Processed {progress.processed}/{progress.total} follows
              </div>
            )}
          </div>

          {error ? (
            <div className="text-red-500 p-4 rounded bg-red-50 border border-red-200">
              {error}
            </div>
          ) : results.length === 0 && isAnalyzing ? (
            <div className="text-gray-500 text-center py-8">
              <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin" />
              No results yet. Analysis in progress...
            </div>
          ) : (
            <div className="grid gap-3">
              {results.map((item, index) => {
                const profile = profiles[item.handle];
                return (
                  <div 
                    key={item.handle}
                    className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-gray-500 text-sm font-mono w-6 flex-shrink-0">
                      {index + 1}
                    </span>
                    <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-100 flex-shrink-0">
                      {profile?.avatar ? (
                        <img 
                          src={profile.avatar} 
                          alt={profile.displayName || item.handle}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-blue-100">
                          <User className="w-6 h-6 text-blue-500" />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-1 justify-between items-start gap-2 min-w-0">
                      <div className="flex flex-col min-w-0 max-w-32 md:max-w-64">
                        <a 
                          href={getBskyUrl(item.handle)} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="font-medium text-blue-600 hover:text-blue-800 hover:underline truncate"
                        >
                          {profile?.displayName || item.handle}
                        </a>
                        <span className="text-sm text-gray-500 truncate">
                          {window.innerWidth < 640 && item.handle.includes('bsky.social')
                            ? item.handle.split('.')[0]
                            : item.handle}
                        </span>
                        {profile?.description && (
                          <p className="text-xs text-gray-600 mt-1 line-clamp-2 "
                          title={profile.description}>
                            {profile.description}
                          </p>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0 text-gray-600">
                        <span className="text-sm font-medium">{item.count}</span>
                        <span className="text-xs block">
                          {window.innerWidth < 640 ? 'follows' : 'follows'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};


export default BlueskyAnalyzer;
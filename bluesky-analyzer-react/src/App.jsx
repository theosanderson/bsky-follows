import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, User } from 'lucide-react';
import { PiButterflyFill } from "react-icons/pi";
// In-memory cache for profile data and pending requests
const profileCache = new Map();
const pendingRequests = new Map();



const useBlueskyProfiles = () => {
  const [profiles, setProfiles] = useState({});
  const [loadingHandles, setLoadingHandles] = useState(new Set());

  const fetchProfile = useCallback(async (handle) => {
    if (profileCache.has(handle)) {
      return profileCache.get(handle);
    }

    if (pendingRequests.has(handle)) {
      return pendingRequests.get(handle);
    }

    setLoadingHandles(prev => new Set([...prev, handle]));

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
      setProfiles(prev => ({
        ...prev,
        [handle]: profile
      }));
    }
    
    return profile;
  }, []);

  return { profiles, fetchProfile, loadingHandles };
};

const ResultItem = ({ item, index, onInView, handleToAnalyze }) => {
  const itemRef = useRef(null);

  useEffect(() => {
    // Create two observers: one for immediate view and one for preloading
    const viewObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onInView(item.handle);
            // Unobserve after first intersection
            viewObserver.unobserve(entry.target);
            preloadObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    // Preload observer with a larger rootMargin to detect items before they enter the viewport
    const preloadObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onInView(item.handle);
            // Unobserve after first intersection
            preloadObserver.unobserve(entry.target);
          }
        });
      },
      {
        rootMargin: '50% 0px 50% 0px', // Load items when they're within 50% of the viewport height
        threshold: 0
      }
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
          <span className="text-sm text-sky-700 truncate">
            {window.innerWidth < 640 && item.handle.includes('bsky.social')
              ? item.handle.split('.')[0]
              : item.handle}
          </span>
          {item.profile?.description && (
            <p className="text-xs text-sky-600 mt-1 line-clamp-2"
            title={item.profile.description}>
              {item.profile.description}
            </p>
          )}
        </div>
        <div className="text-right flex-shrink-0 text-sky-800">
          <span className="text-sm font-medium">{item.count}</span>
          <span className="text-xs block">follows</span>
        </div>
      </div>
    </div>
  );
};


const BlueskyAnalyzer = () => {
  const [inputValue, setInputValue] = useState('');  // New state for input value
  const [handleToAnalyze, setHandleToAnalyze] = useState(''); // State for the handle to actually analyze
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [error, setError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const { profiles, fetchProfile, loadingHandles } = useBlueskyProfiles();

  // Enhance results with profile data
  const enhancedResults = results.map(result => ({
    ...result,
    profile: profiles[result.handle]
  }));

  const handleInView = useCallback((handle) => {
    fetchProfile(handle);
  }, [fetchProfile]);

  useEffect(() => {
    let eventSource = null;

    const startAnalysis = () => {
      if (!handleToAnalyze.trim()) return;
      
      if (eventSource) {
        eventSource.close();
      }

      setIsAnalyzing(true);
      setResults([]);
      setError(null);

      eventSource = new EventSource(`//bsky-follow-suggestions.theo.io/analyze/${handleToAnalyze}`);

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
  }, [handleToAnalyze, isAnalyzing]);

  const handleSubmit = (e) => {
    e.preventDefault();
    let processedHandle = inputValue.trim();
    
    if (!processedHandle.includes('.')) {
      processedHandle = `${processedHandle}.bsky.social`;
    }
    
    if (processedHandle.startsWith('@')) {
      processedHandle = processedHandle.slice(1);
    }

    setHandleToAnalyze(processedHandle.toLowerCase());  // Set the handle to analyze
    setIsAnalyzing(true);
  };

  
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-white p-4 md:p-8">
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

        <div className="bg-white/80 backdrop-blur-sm rounded-lg shadow-lg shadow-sky-100/50 p-6 mb-8 border border-sky-100">
          <form onSubmit={handleSubmit} className="flex flex-col md:flex-row gap-4">
            <input 
              type="text" 
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Enter Bluesky handle (e.g., user.bsky.social)" 
              className="flex-1 p-2 border border-sky-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 bg-white/90"
            />
            <button 
              type="submit"
              className="bg-sky-500 text-white px-6 py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-sm hover:shadow-md"
            >
              Analyze
            </button>
          </form>
        </div>

        <div className="bg-white/80 backdrop-blur-sm rounded-lg shadow-lg shadow-sky-100/50 p-6 border border-sky-100">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sky-700">Results</h2>
            {isAnalyzing && progress.total > 0 && (
              <div className="text-sm text-sky-600 flex items-center">
                {progress.processed !== 0 && progress.processed !== progress.total &&
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                }
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
              Initialising: finding the people you follow..
            </div>
          ) : (
            <div className="grid gap-3">
              {enhancedResults.map((item, index) => (
                <ResultItem
                  key={item.handle}
                  item={item}
                  index={index}
                  onInView={handleInView}
                  handleToAnalyze={handleToAnalyze}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
export default BlueskyAnalyzer;
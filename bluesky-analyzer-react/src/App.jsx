import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, User, Lock, EyeOff, Eye, LockOpen 
  ,
  ExternalLink
} from 'lucide-react';
import { PiButterflyFill } from "react-icons/pi";

import { BskyAgent } from '@atproto/api';

import {Toaster, toast} from 'react-hot-toast';


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
          Sort by total (favours large accounts)
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
          Sort by proportion (favours specific accounts)
        </label>
      </div>
    </div>
  );
};


const calculateWilsonScore = (positive, total, confidence = 0.95) => {
  if (total === 0) return 0;
  
  // z score for confidence level (0.95 = 1.96)
  const z = 1.96;
  
  const phat = positive / total;
  const z2 = z * z;
  const n = total;
  
  // Wilson score interval lower bound formula
  const numerator = phat + z2/(2*n) - z * Math.sqrt((phat*(1-phat) + z2/(4*n))/n);
  const denominator = 1 + z2/n;
  
  return numerator/denominator;
};



// Keep existing cache setup
const profileCache = new Map();
const pendingRequests = new Map();

const FollowButton = ({ handle, appPassword, username, className = "" }) => {
  const [isFollowing, setIsFollowing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  if(handle===username) {
    return null
  }

  if(!appPassword) {
    return null
  }


  const handleFollowAction = async () => {
    if (isLoading || !appPassword || !username) return;
    
    setIsLoading(true);
    try {
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      await agent.login({ identifier: username, password: appPassword });
      
      const { data } = await agent.getProfile({ actor: handle })
      const { did, displayName } = data

      if (!isFollowing) {
        await agent.follow(did);
        setIsFollowing(true);
      } else {
        await agent.deleteFollow(did);
        setIsFollowing(false);
      }
    } catch (error) {
      console.error('Follow action failed:', error);
      toast.error('Failed to follow. Maybe the app password is wrong?');
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
      {
        rootMargin: '50% 0px 50% 0px',
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
            <p className="text-xs text-sky-600 mt-1 line-clamp-2"
            title={item.profile.description}>
              {item.profile.description}
            </p>
          )}
        </div>
        <div className="text-right flex-shrink-0 text-sky-800">
          <span className="text-sm font-medium">{item.count}
            {weightedEnabled &&
            <span>/{item.followers}</span>
            }
            
            
            </span>
          <span className="text-xs block">follows</span>
        </div>
      </div>
    </div>
  );
};

// Main component with app password functionality
const BlueskyAnalyzer = () => {
  const [inputValue, setInputValue] = useState('');
  const [handleToAnalyze, setHandleToAnalyze] = useState('');
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [error, setError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [showAppPasswordSection, setShowAppPasswordSection] = useState(false);
  const [weightedEnabled, setWeightedEnabled] = useState(false);
  

  const { profiles, fetchProfile, loadingHandles } = useBlueskyProfiles();

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
          if( data.processed_count &&  data.processed_count == data.total_count){
            window.finished = true
          }
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
          if (!window.finished){
          setError('Connection error. Please try again.');
          }
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
    
     processedHandle = processedHandle.replace(/[^\x00-\x7F]/g, '');
    
    if (!processedHandle.includes('.')) {
      processedHandle = `${processedHandle}.bsky.social`;
    }
    
    if (processedHandle.startsWith('@')) {
      processedHandle = processedHandle.slice(1);
    }


    setHandleToAnalyze(processedHandle.toLowerCase());
    setIsAnalyzing(true);
    window.finished=false;
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
                className="bg-sky-500 text-white px-6 py-2 rounded-lg hover:bg-sky-600 transition-colors shadow-sm hover:shadow-md"
              >
                Analyze
              </button>
            </div>
            
            {!showAppPasswordSection ? (

              ( isAnalyzing || results.length >0) &&
              <button
                type="button"
                onClick={() => setShowAppPasswordSection(true)}
                className="text-sky-600 hover:text-sky-500 text-sm flex items-center gap-2 self-start"
              >
                <LockOpen className="w-4 h-4" />
                Add an app password to enable follow buttons (optional)
              </button>

            
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
            {isAnalyzing && progress.total > 0 && (
              <div className="text-sm text-sky-600 flex items-center">
                {progress.processed !== 0&& progress.processed !== progress.total &&
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
          <div>

            {
              results.length > 0 &&
            
            <WeightToggle weighted={weightedEnabled} onToggle={setWeightedEnabled} />
}
            


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

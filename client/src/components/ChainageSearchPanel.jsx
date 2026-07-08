import React, { useRef, useState, useEffect } from "react";


const ChainageSearchPanel = ({ city, onSelectRoad, onFeatureUnavailable }) => {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [show, setShow] = useState(false);
    const searchCacheRef = useRef(new Map());
    const onFeatureUnavailableRef = useRef(onFeatureUnavailable);

    useEffect(() => {
        onFeatureUnavailableRef.current = onFeatureUnavailable;
    }, [onFeatureUnavailable]);

    useEffect(() => {
        const term = String(query || "").trim();
        if (term.length < 2) {
            setResults([]);
            return;
        }

        const cacheKey = `${String(city || "").toLowerCase()}|${term.toLowerCase()}`;
        if (searchCacheRef.current.has(cacheKey)) {
            setResults(searchCacheRef.current.get(cacheKey));
            return;
        }

        const controller = new AbortController();
        const delay = setTimeout(async () => {
            try {
                const res = await fetch(
                    `/api/chainage-search/${city}?q=${encodeURIComponent(term)}`,
                    { signal: controller.signal }
                );
                const data = await res.json();
                if (!res.ok) {
                    if (data?.error === "FEATURE_IN_PROGRESS") {
                        onFeatureUnavailableRef.current?.(data);
                    }
                    setResults([]);
                    return;
                }
                searchCacheRef.current.set(cacheKey, data);
                setResults(data);
            } catch (e) {
                if (e?.name === "AbortError") return;
                setResults([]);
            }
        }, 300);

        return () => {
            clearTimeout(delay);
            controller.abort();
        };
    }, [query, city]);

    return (
        <div className="chainage-search-panel">

            <input
                type="text"
                placeholder="Search Road..."
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setShow(true);
                }}
            />

            {show && results.length > 0 && (
                <div className="search-dropdown">
                    {results.map((r, i) => (
                        <div
                            key={i}
                            className="search-item"
                            onClick={() => {
                                setQuery(r.road_name);
                                setShow(false);

                                onSelectRoad(r); // 🔥 IMPORTANT
                            }}
                        >
                            <div className="search-item-left">
                                <b>{r.road_name}</b>
                                <small>Ward {r.ward_no ?? "NA"}</small>
                            </div>


                            <span>{r.road_id}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default ChainageSearchPanel;

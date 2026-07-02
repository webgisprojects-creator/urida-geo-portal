import React, { useState, useEffect } from "react";


const ChainageSearchPanel = ({ city, onSelectRoad }) => {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (!query || query.length < 2) {
            setResults([]);
            return;
        }

        const delay = setTimeout(async () => {
            try {
                const res = await fetch(
                    `/api/chainage-search/${city}?q=${encodeURIComponent(query)}`
                );
                const data = await res.json();
                setResults(data);
            } catch (e) {
                setResults([]);
            }
        }, 300);

        return () => clearTimeout(delay);
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
// examples/App.js

import React from "react";
import APIDemo from "./components/APIDemo";

function App() {
    return (
        <div style={{ padding: "20px" }}>
            <div style={{ marginBottom: "20px", textAlign: "center" }}>
                <h1>Tendrl JavaScript SDK Example</h1>
            </div>
            <APIDemo />
        </div>
    );
}

export default App;


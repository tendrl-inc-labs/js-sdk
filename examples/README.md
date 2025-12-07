# Tendrl JavaScript SDK Examples

This directory contains example applications demonstrating how to use the Tendrl JavaScript SDK.

## Examples

The examples directory contains a React application demonstrating the Tendrl SDK.

### Features Demonstrated

- API-based messaging (uses native fetch)
- Message publishing with tags (both object and string messages)
- Automatic message checking
- Message callbacks
- Connection state management

### Files

- `App.js` - Main application component
- `index.js` - Application entry point
- `components/APIDemo.js` - Demo component
- `public/index.html` - HTML template

**Note:** The example can be extended to demonstrate offline storage by enabling `offlineStorage: true` in the client configuration.

## Running the Examples

### Option 1: Copy to Your Project (Recommended)

The easiest way to use these examples is to copy them into your own React project:

1. Copy the example files to your project's `src/` directory
2. Install the SDK as a package (or copy the SDK files)
3. Update imports to use the installed package

### Option 2: Run from Examples Directory

To run the examples directly from this directory:

1. Install dependencies:

   ```bash
   cd examples
   npm install
   ```

2. Create a symlink or copy the SDK files:

   ```bash
   # From the examples directory, create a symlink to src
   ln -s ../src src
   ```

3. Set up environment variables (create a `.env` file in the examples directory):

   ```bash
   REACT_APP_TENDRL_KEY=your_api_key
   # API URL is set statically in code, no need to configure
   ```

4. Run the example:

   ```bash
   npm start
   ```

This will start the React development server. The example application will be available at `http://localhost:3000`.

**Note**: The examples import the SDK from `../../src/` (or `./src/` if using symlink). In a production application, you would install the SDK as a package and import it normally:

```javascript
import useTendrlClient from 'tendrl-js-sdk/hooks/useTendrlClient';
```

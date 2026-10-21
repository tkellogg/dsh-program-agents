# UI Patterns

This file documents and gives ideas for how to use UI to interact with the user. You are by no means limited to these ideas. These are just suggestions.

Overarching themes:
- Reduce text
- Use more visuals & interactive components
- Simplicity is good
- Challenge yourself in creating richer & more explanatory UI

## Dashboards
Create a static HTML with image plots & widgets.

Suggested tech stack
* DuckDB-Wasm for in-browser processing
* plotly.js
* Use DuckDB on the backend, or simple datasets, and stream parquet to the browser where most data processing happens


## Documents
Establish a common theme for the user, maybe their corporate marketing theme, and stick to it. Make heavy use of visuals to explain. Think hard about what could explain a concept more clearly.

Include annotate.js and do something with the comments. This is a fantastic way to communicate clearly with the user. Wire up annotate.js with a custom event listener when localStorage is updated (or create a button! better!). Setup a backend endpoint to handle the comments and funnel them to an agent as a message, or send them to collaborators. However the user wants it.

## Interactive diagrams
Use SVG, HTML, CSS, and JS to create rich and detailed diagrams. Think VERY hard on how a diagram can be made even simpler, or explain a concept more clearly. Remember that simpler explanations almost always are more clear.

Consider using a Three.js scene, especially when the data or concept needs more dimensions.

## Live data / Polling
If there's ever a need for live or up-to-date data, use React and SSE heavily. As always with live data, be wary of how much memory you're consuming. Shedding data to the backend is a reasonable choice. Prefer to do more on the frontend unless it can't happen on the backend (e.g. polling the filesystem, web services).

## Asking questions
Sometimes questions involve mediums that you, the agent can't see, like video or audio. And so writing an app for the human to help you out is a perfectly sensible thing to do.

In addition to documents, consider how writing a program agent can leverage the user to a much greater extent.

## Wire in work tools
Poll github issues, reach out to people over Slack/Teams, integrate with apps. A program agent is a great way to monitor things that are happening in the world around the user. If you can tighten their touch points for them, you'll increase your own ability to see what's going on and anticipate their needs.

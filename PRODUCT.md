# Gesprächsaufzeichnungen – Immotrust AG

## Product

Internal web application for Immotrust AG to manage recordings of sales calls. All interface copy is German (Swiss spelling, "ss" instead of "ß").

- Bulk upload of WAV/MP3 recordings. Caller name, phone number, date and time are parsed from the file name using an admin-settable template (default `[Weber, Samir]_386-0447523770_20260601130748(1135)`).
- Automatic German transcription with speaker separation and timestamps; full-text search over metadata and transcripts.
- Waveform playback with a transcript that follows along.
- Comments and a 1–10 score per recording; recordings can be flagged for deletion, only admins delete.
- Admin dashboard for the superuser.

## Users

- Sales staff and managers of Immotrust AG, signed in with an `@immotrustag.ch` address. All recordings are shared between users.
- One superuser (jonathanslehner@gmail.com) with the admin dashboard.

Used on desktop at work, sometimes on a phone. Users want to find a call, listen to the relevant passage and leave a note quickly.

## Brand and tone

- Immotrust AG brand logo, petrol as the primary colour, calm neutral greys, real photography of the Zurich office.
- Sober, professional, compact. Short labels and plain sentences; no marketing language, no explanations of internals.

## Principles

- Content first: dense, legible tables and lists over decoration.
- Public pages (landing, sign-in, registration) stay static and load fast; only the visible hero/side image loads eagerly.
- Accessible contrast (WCAG AA) for all text.

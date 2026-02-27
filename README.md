# Patreon Scraper Puppeteer

A web scraper built with Puppeteer to scrape posts, comments, replies, media, and third-party video links from a Patreon creator's page. Saves scraped data as `.mhtml` snapshots and downloads audio/video/image files with titled filenames.

Fork of [kennethkn/patreon-scraper-puppeteer](https://github.com/kennethkn/patreon-scraper-puppeteer) with the following additions:
- Download audio/video files with titled filenames (`postId - title.ext`)
- Download post cover images
- Capture YouTube/Vimeo links per post
- `yearsToScrape` config option to scrape specific years
- Fix for year filter index bug when using `scrapeByYear`

## Disclaimer

This project is for educational purposes only. I am not responsible for any misuse of this project.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Usage](#usage)
  - [Configuration](#configuration)
  - [Running the Scraper](#running-the-scraper)
  - [Output](#output)
  - [Limitation](#limitation)
- [Scripts](#scripts)
- [Project Structure](#project-structure)
- [What is MHTML?](#what-is-mhtml)
- [Maintenance](#maintenance)
- [License](#license)

## Prerequisites

- [Node.js](https://nodejs.org/en/download/)
- Patreon account language set to English

## Setup

```sh
npm run setup
```

After logging in, you can quit the browser safely.

## Usage

### Configuration

Edit [`config.ts`](config.ts):

```ts
const config = {
  // Set the creator to scrape (https://www.patreon.com/johndoe -> johndoe)
  creator: 'johndoe',

  // Each year will be saved in a separate file to prevent memory issues
  scrapeByYear: true,

  // Only scrape specific years. Leave empty to scrape all years.
  // Example: ['2026', '2025']
  yearsToScrape: [],

  // Set the number of posts to scrape in total / per year if scrapeByYear is true
  // Beware that browser will crash if set too high (>90) because of insufficient memory
  numPostsToScrape: 90,

  // Load all comments/replies for each post if true
  scrapeComments: true,
  scrapeReplies: true,
};
```

### Running the Scraper

```sh
npm start
```

### Output

```plaintext
dist/johndoe/
├── 2024.mhtml
├── 2024-media/
│   ├── 12345678 - Post Title.mp3
│   └── images/
│       └── 12345678_abc12345 - Post Title.png
├── 2024-links.txt       <- YouTube/Vimeo links found in 2024 posts
├── 2023.mhtml
├── 2023-media/
...
```

- `.mhtml` — full page snapshot, open in Chrome or Edge
- `-media/` — downloaded audio/video files, named `postId - title.ext`
- `-media/images/` — post cover images
- `-links.txt` — YouTube/Vimeo links captured from posts

### Limitation

On a 16GB RAM machine, the scraper can handle ~90 posts (with full comments and replies) before the browser crashes due to memory exhaustion. This is a Patreon pagination issue (infinite scroll). Use `scrapeByYear` to stay within the limit, and `yearsToScrape` to resume from a specific year if it crashes mid-run.

## Scripts

- `start`: Runs the scraper
- `login`: Opens browser for Patreon login
- `setup`: Installs dependencies and runs login
- `clean`: Clears the `dist` directory
- `logout`: Deletes the `browser-data` directory

## Project Structure

```plaintext
.
├── config.ts         <- Configuration
├── dist/
│   └── <creator>/    <- Output
└── src/
    ├── index.ts      <- Main scraper
    └── login.js      <- Login helper
```

## What is MHTML?

MHTML (MIME HTML) bundles a web page and all its resources into a single file. Open `.mhtml` files in Chrome or Edge — drag and drop if clicking doesn't work.

## Maintenance

Potential future issues:
- Patreon changing their website structure
- Stealth plugin no longer bypassing detection

## License

ISC License

# Personal Scraper

A personal link scraper that extracts Pixeldrain, FileKeeper, and DataNodes links, then generates `wget` commands or IDM URL lists. FileKeeper pages use a local Python resolver for downloads or IDM clipboard batch import. Not a universal scraper — it only supports these hosts.

## License

This project is licensed under the [MIT License](LICENSE).

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone https://github.com/varunojhaa/personal-scraper.git
cd personal-scraper
npm i
npm run dev
```

This repository is the working copy for the new The Drake Law Firm website. It holds a read-only inventory of the public URLs on https://thedrakelawfirm.com so the new site can be planned without changing the live WordPress site.

- `site/` is the website Netlify serves. It is generated. Do not edit files in it by hand.
- `tools/build.mjs` generates `site/` from `content/` (page text and settings) and `inventory/snapshots/` (the saved live pages). Run `npm install` once, then `node tools/build.mjs`.
  - The default build is staging: no analytics, and every page is marked noindex.
  - The public build is `SITE_MODE=production node tools/build.mjs`.
- `tools/lib/css.mjs` turns the live site's stylesheets into one shared `site/assets/site.css` plus a small style block per page.
- `tools/assets/site.js` replaces the plugin scripts: mobile menu, FAQ accordions, reviews slider, video carousel and lightbox, accessibility toolbar.
- `tools/partials/` holds the analytics tags (Google Tag Manager, Google tag, CallRail) and the accessibility toolbar.
- Forms are Netlify Forms. They send visitors to /thank-you/ after submitting.
- Images are not in the repo yet. They keep their WordPress addresses under `site/wp-content/uploads/`.
- `tools/` holds scripts, including the public URL inventory.
- `inventory/` holds the generated reports (`urls.csv` and `summary.md`).

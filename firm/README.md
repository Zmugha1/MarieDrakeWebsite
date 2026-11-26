# The Drake Law Firm website

The public website for The Drake Law Firm, P.C. at https://thedrakelawfirm.com.

It is a static website. Every page is a plain HTML file. There is no WordPress, no database and no plugins.

## Where things are

- `site/` is the website. Netlify publishes this folder as it is. There is no build step.
- `site/index.html` is the homepage. Every other page is `site/<web address>/index.html`. For example, the divorce page is `site/colorado/divorce/index.html`.
- `site/assets/site.css` holds the styles shared by every page. `site/assets/site.js` runs the menu, FAQ sections, sliders, video FAQ filters and accessibility toolbar.
- `site/wp-content/uploads/` holds the images. They keep their original web addresses.
- `site/_redirects` lists old web addresses and where they now go.
- `site/sitemap_index.xml` and the files it lists are the sitemaps for Google.
- `site/llms.txt` and `site/llms-full.txt` describe the site for AI assistants.
- `site/robots.txt` and `site/_headers` control search engine access.

## Contact forms

Forms are handled by Netlify Forms. Messages appear in Netlify under Forms, and Netlify emails a notification for each one. After sending, visitors go to /thank-you/.

## Making a change

1. Edit the page in `site/`.
2. Commit and push to `main`.
3. Netlify publishes the change within a minute or two.

Maintained by Dr. Data Decision Intelligence LLC.

# Public URL inventory

Read-only check of https://thedrakelawfirm.com on 2026-11-25T02:05:16.006Z. No WordPress login. No page content exported.

## Post types exposed in the REST API

| Type | rest_base | Name |
| --- | --- | --- |
| attachment | media | Media |
| e-floating-buttons | e-floating-buttons | Floating Elements |
| elementor_library | elementor_library | My Templates |
| nav_menu_item | menu-items | Navigation Menu Items |
| page | pages | Pages |
| post | posts | Posts |
| video-faqs | video-faqs | Video Faqs |
| wp_block | blocks | Patterns |
| wp_font_face | font-families/(?P<font_family_id>[\d]+)/font-faces | Font Faces |
| wp_font_family | font-families | Font Families |
| wp_global_styles | global-styles | Global Styles |
| wp_navigation | navigation | Navigation Menus |
| wp_template | templates | Templates |
| wp_template_part | template-parts | Template Parts |

## Counts

| Item | Count |
| --- | --- |
| Pages | 88 |
| Posts | 234 |
| Video FAQs | 65 |
| Sitemap URLs | 395 |
| In sitemap but not in API | 14 |
| In API but not in sitemap | 5 |

API counts cover pages, posts, and the video FAQ type when that type is exposed. Sitemap counts cover every URL in the public sitemap index.

## Video FAQ type

Exposed as video-faqs (rest_base `video-faqs`).

## Post types not exposed in the API

None. Content sitemap names matched a public REST post type or a public taxonomy. Author archives in author-sitemap.xml are users, not a post type. A probe of /wp-json/wp/v2/author during this run returned HTTP 404.

## In sitemap but not in API

### video-faqs-sitemap.xml (1)

- https://thedrakelawfirm.com/video-faqs/

### post_tag-sitemap.xml (11)

- https://thedrakelawfirm.com/tag/alimony-and-spousal-support/
- https://thedrakelawfirm.com/tag/colorado-divorce/
- https://thedrakelawfirm.com/tag/colorado-divorce-attorney/
- https://thedrakelawfirm.com/tag/colorado-family-law/
- https://thedrakelawfirm.com/tag/colorado-law/
- https://thedrakelawfirm.com/tag/family-law-attorney/
- https://thedrakelawfirm.com/tag/family-law-divorce/
- https://thedrakelawfirm.com/tag/legal-updates/
- https://thedrakelawfirm.com/tag/managed-url-by-permalink-manager-lite/
- https://thedrakelawfirm.com/tag/property-division/
- https://thedrakelawfirm.com/tag/spousal-maintenance/

### author-sitemap.xml (2)

- https://thedrakelawfirm.com/author/marie-drake/
- https://thedrakelawfirm.com/author/tatiana/

## In API but not in sitemap

- https://thedrakelawfirm.com/lp/ (page)
- https://thedrakelawfirm.com/thank-you-zip/ (page)
- https://thedrakelawfirm.com/jefferson-county-divorce-lawyer-colorado-divorce-mediation-attorney/ (page)
- https://thedrakelawfirm.com/thank-you/ (page)
- https://thedrakelawfirm.com/all-forms/ (page)

## Errors

- Duplicate API URL https://thedrakelawfirm.com/colorado/alimony (ids 10129 and 1069)

Requests sent: 15. Wait between requests: 300 ms.

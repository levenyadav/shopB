-- =============================================================================
-- 029_pwa_theme.sql — brand/theme colour for the installable PWA (Settings §6.11).
--
-- The shop identity already carries logo_url, icon_url and brand_text (012). To
-- make the app installable as a branded PWA we let the owner pick one accent
-- colour. It drives three things at once, all from this single value:
--   * the primary UI accent (--color-peacock is overridden at runtime),
--   * the Web App Manifest theme_color (the installed app's chrome), and
--   * the <meta name="theme-color"> the mobile browser paints its bar with.
--
-- Rides the existing shops_select (public read — the shopfront/manifest need it
-- without a login) and shops_update (owner only). Buyer-safe: meant to be public.
-- =============================================================================



# CTE2 Drop Machine

A slot machine that shows how mob drops work in Craft to Exile 2 (Mine and Slash). Kill a mob, then follow every step
of the roll: the loot modifiers, the independent roll for each drop type (at most 75% per roll), rarity weights and the
Magic Find upgrade, the 20-item cap, and the bonus pool (Abyssal Eye, Pinnacle Gems). It also has an odds sheet, a bulk
simulator and the atlas passive tree.

## Use it locally

It's a static page with no build step.

- **Quickest:** double-click `index.html`.
- **Or through a local server** (only needed if your browser blocks local files):

  ```
  python -m http.server 8000
  ```

  then open <http://localhost:8000>.

Your scenario, server settings and atlas allocation are saved in the browser.

## Update it after a pack update

`pools.js` and `icons/` are generated from an installed CTE2 instance (mod jars, openloader data and resource
overrides, and `defaultconfigs/mine_and_slash-server.toml`). To regenerate them:

```
pip install pillow numpy
python tools/extract.py "G:/PrismLauncher/instances/<instance>/minecraft"
```

With no argument it uses the Atlas Update Test instance. Then click **Load CTE2 pack values** in Server settings so
the page picks up the new config.

## Publish on GitHub Pages

`.github/workflows/pages.yml` publishes the page on every push to `main`.

1. Push this folder to a GitHub repository (branch `main`).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push again, or run the workflow from the **Actions** tab. The page URL appears in the workflow run
   (normally `https://<user>.github.io/<repo>/`).

Only the page files are published; `tools/` isn't.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | the page |
| `app.js` | the drop engine (a port of `MasterLootGen` and the loot blueprints) and the UI |
| `pools.js`, `icons/` | generated from the pack by `tools/extract.py` — don't edit by hand |
| `tools/extract.py` | the extractor |

# @popcorn245/cornfield-components

[cornfield](https://github.com/popcorn245/CornField)'s interface as web components: `<corn-review>` (a proposal on the map, with Approve and Send back, in one tag), `<corn-map>` and `<corn-scope>` today, more to follow. Built with StencilRS, as ES modules, with type declarations and a `tokens.css`.

```sh
npm install @popcorn245/cornfield-components
```

```js
import '@popcorn245/cornfield-components/corn-review';   // registers <corn-review>; or '@popcorn245/cornfield-components' for all of them
```

```html
<corn-review src="https://map.example.com" proposal="0042-retire-the-old-export"></corn-review>
```

The package carries cornfield's own version number: `0.48.0` of the package is the build of cornfield `0.48.0`, the one its server serves at `/cornfield/components/`. A page that does not use a bundler can load the same files from the server with one `<script type="module">` line.

Everything is in [docs/embedding.md](https://github.com/popcorn245/CornField/blob/main/docs/embedding.md): the tag's properties, events and parts, the tokens, the host's Content-Security-Policy.

The modules register custom elements when they are imported (`"sideEffects": true`): a bundler must keep an `import '…/corn-map'` that uses nothing from it.

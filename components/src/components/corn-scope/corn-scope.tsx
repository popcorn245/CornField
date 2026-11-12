import { Component, Element, Event, EventEmitter, Prop, Watch } from '@stencil/core';
import { mountScope } from '../../../../explorer/pieces/scope.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/** What `cornAuth` says: the server wants the maintainer signed in, and where its sign-in is (it returns to this page) */
export interface CornAuthDetail {
  /** 401 or 403 */
  status: number;
  /** `<src>/auth/start?returnTo=<this page's address>`: a link the host or the piece puts in front of the person; the component never navigates the window */
  signIn: string;
}

/** What `cornError` says: something the pieces could not do, by `kind` */
export interface CornErrorDetail {
  /** `not-listed` (the server gave this page no CORS answer: its origin is not in `embed.origins`), `offline`, `server` (it answered with something that is not a config or a map), `address` (`src` is not an http(s) address), `version` (the package and the server differ by a minor or more; it keeps working), `theme` (the server's theme could not be had), `second-map` (a scope holds one map) */
  kind: string;
  /** A few words more, plain text: the origin to list, the problem with the address, the two versions */
  message?: string;
}

/**
 * Where the data comes from, and what the pieces inside it share (spec 0011 D5). It shows nothing of its own and has no shadow root: the `corn-*`
 * pieces inside it (today `corn-map`) share one instance (one selection, one camera, one topology), and `src` is the address of a cornfield server it
 * reads their config and topology from, with the signed-in maintainer's session. A thin shell (spec 0011 D1): the work is explorer/pieces/scope.js.
 */
@Component({
  tag: 'corn-scope',
})
export class CornScope {
  @Element() el!: HTMLElement;

  /** The base address of a cornfield server, `https://map.example.com` (an http(s) origin with an optional path). Another value is refused, and said in the pieces and in `cornError`. */
  @Prop() src?: string;

  /** The ground the pieces are drawn for: `light` or `dark` forces it, `auto` (or none) follows the page's own `data-theme` or the system's setting */
  @Prop({ reflect: true }) theme?: 'light' | 'dark' | 'auto';

  /** Wear the server's theme: its stylesheet goes into every piece, and its `--corn-*` tokens onto this element. Off by default: a host app has its own look. */
  @Prop() useTheme: boolean = false;

  /** The map to draw, for a host that fetches for itself: the object `topology.json` holds. With it (and `config`) no request is made. */
  @Prop() topology?: { nodes: Array<{ id: string; [key: string]: unknown }>; edges?: Array<{ from: string; to: string; [key: string]: unknown }> } | null;

  /** The object `/cornfield/config.json` holds, for a host that fetches for itself */
  @Prop() config?: { [key: string]: unknown } | null;

  /** The words the host overrides (a flat map of `strings` keys to text); they win over the server's */
  @Prop() strings?: { [key: string]: string } | null;

  /** The scope has its data: read from the server, or handed in. Once per server. */
  @Event() cornReady!: EventEmitter<void>;

  /** The server answered a gated read with 401 or 403: the maintainer has to sign in. The piece shows a link to `signIn`. */
  @Event() cornAuth!: EventEmitter<CornAuthDetail>;

  /** Something the pieces could not do */
  @Event() cornError!: EventEmitter<CornErrorDetail>;

  private scope: ReturnType<typeof mountScope> | null = null;
  private loaded = false;

  connectedCallback() {
    if (this.loaded) this.mountScope(); // reconnected: a new instance, the pieces below are told
  }

  componentWillLoad() {
    this.loaded = true;
    this.mountScope();
  }

  disconnectedCallback() {
    if (this.scope) this.scope.destroy();
    this.scope = null;
  }

  private mountScope() {
    if (this.scope) return;
    this.scope = mountScope(this.el, {
      src: this.src, theme: this.theme, useTheme: this.useTheme, topology: this.topology, config: this.config, strings: this.strings,
      tokens: defaultTokens, version: __CORNFIELD_VERSION__, pageUrl: () => (typeof location === 'undefined' ? '' : location.href),
      onReady: () => this.cornReady.emit(),
      onAuth: (detail: CornAuthDetail) => this.cornAuth.emit(detail),
      onError: (detail: CornErrorDetail) => this.cornError.emit(detail),
    });
  }

  @Watch('src')
  @Watch('theme')
  @Watch('useTheme')
  @Watch('topology')
  @Watch('config')
  @Watch('strings')
  changed(value: unknown, _old: unknown, name: string) {
    if (this.scope) this.scope.update({ [name]: value });
  }
}

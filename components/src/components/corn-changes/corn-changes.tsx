import { Component, Element } from '@stencil/core';
import { mountAround } from '../../../../explorer/pieces/around.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
import * as piece from '../../../../explorer/pieces/changes.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/**
 * What the proposal changes, and the scenarios that walk through it: one row for each node and edge it adds, changes or removes (a click selects it on the map and frames it, and fills a
 * `<corn-node-panel>` in the same scope), then, persona by persona, the scenarios, and the scenario player, which flies the map from step to step. It is for use inside a `<corn-scope>` that has a `proposal`,
 * beside a `<corn-map>`. A thin shell (spec 0011 D1): it mounts the engine's piece (explorer/pieces/changes.js) in its shadow root on the instance of the nearest `<corn-scope>`,
 * through explorer/pieces/around.js, and ends it when it leaves the page. It holds no behaviour (test/shell.test.ts). It has no properties and sends no events of its own: the scope's selection and the
 * map's `cornSelect` say what is chosen. A scope holds one of it: a second says so, and takes over when the first leaves.
 */
@Component({
  tag: 'corn-changes',
  styleUrls: ['../../../../explorer/css/base.css', '../../../../explorer/css/changes.css', 'corn-changes.css'],
  encapsulation: { type: 'shadow' },
})
export class CornChanges {
  @Element() el!: HTMLElement;

  private piece: ReturnType<typeof mountAround> | null = null;
  private scope: ReturnType<typeof joinScope> | null = null;
  private loaded = false;

  connectedCallback() {
    if (this.loaded) this.mountPiece(); // reconnected: a new piece, the old one went with the disconnect
  }

  componentDidLoad() {
    this.loaded = true;
    this.mountPiece();
  }

  disconnectedCallback() {
    this.unmountPiece();
  }

  private unmountPiece() {
    if (this.piece) this.piece.destroy();
    this.piece = null;
    if (this.scope) this.scope.leave();
    this.scope = null;
  }

  /** The scope around this element, or its instance, changed (a new server, a scope added or removed): ask again */
  private remount() {
    this.unmountPiece();
    if (this.loaded && this.el.isConnected) this.mountPiece();
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.scope = joinScope(this.el, () => this.remount());
    this.piece = mountAround(piece, this.el.shadowRoot, this.scope.inst, {
      tokens: defaultTokens,
      exclusive: 'corn-changes',
      piece: { inline: true },
    });
  }
}

import { Component, Element } from '@stencil/core';
import { mountAround } from '../../../../explorer/pieces/around.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
import * as piece from '../../../../explorer/pieces/proposal.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/**
 * The open proposal's bar: its title and the copy under review, the counts of what it adds, changes and removes, Before, Diff and After, Whole map, and the ⋯ menu with Close, in a box that fills the
 * place its host gives it. It is for use inside a `<corn-scope>` that has a `proposal`, beside a `<corn-map>`: Before, Diff and After change what the map shows, and Whole map puts the whole map back.
 * A thin shell (spec 0011 D1): it mounts the engine's piece (explorer/pieces/proposal.js) in its shadow root on the instance of the nearest `<corn-scope>`, through
 * explorer/pieces/around.js, and ends it when it leaves the page. It holds no behaviour (test/shell.test.ts). It has no properties and sends no events of its own: the proposal, its `source` and its `view` are
 * the scope's, and so are `cornNavigate`, `cornDecision` and `cornAuth`. A scope holds one of it: a second says so, and takes over when the first leaves.
 */
@Component({
  tag: 'corn-proposal',
  styleUrls: ['../../../../explorer/css/base.css', '../../../../explorer/css/proposal.css', '../../../../explorer/pieces/status.css', 'corn-proposal.css'],
  encapsulation: { type: 'shadow' },
})
export class CornProposal {
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
      exclusive: 'corn-proposal',
      signIn: { during: ['proposal'], clear: 'proposal' }, // a proposal the server refused to open for want of a sign-in: the card with the link
      piece: { inline: true, edit: false },
    });
  }
}

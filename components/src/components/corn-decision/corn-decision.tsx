import { Component, Element } from '@stencil/core';
import { mountAround } from '../../../../explorer/pieces/around.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
import * as piece from '../../../../explorer/pieces/decision.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/**
 * Approve and Send back, the line above Approve that says what it does in this exact state, the note that opens on Send back, the hold with Undo, and what the server answered, in a box that fills the place
 * its host gives it. It decides the proposal the nearest `<corn-scope>` holds, as the signed-in maintainer: the same requests `<corn-review>` makes, from a listed origin. A thin shell (spec 0011 D1): it
 * mounts the engine's piece (explorer/pieces/decision.js) in its shadow root on the instance of that scope, through explorer/pieces/around.js, and ends it when it leaves the page. It holds no behaviour
 * (test/shell.test.ts). It has no properties and sends no events of its own: `cornDecision` and `cornAuth` are the scope's, sent once however many sections it holds. A scope holds one of it: a second says so, and takes over when the first leaves.
 */
@Component({
  tag: 'corn-decision',
  styleUrls: ['../../../../explorer/css/base.css', '../../../../explorer/css/decision.css', '../../../../explorer/pieces/status.css', 'corn-decision.css'],
  encapsulation: { type: 'shadow' },
})
export class CornDecision {
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
      exclusive: 'corn-decision',
      signIn: { during: ['facts', 'review', 'send', 'landing'], clear: 'decision' }, // a read or a press the server refused for want of a sign-in: the card with the link, until a decision is taken
      piece: { inline: true },
    });
  }
}

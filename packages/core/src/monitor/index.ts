/**
 * Moniteur — diffuse les `PipelineEvent` à tous les consommateurs (CLI, web, métriques).
 *
 * L'exécuteur produit déjà un `AsyncGenerator<PipelineEvent>` ; le moniteur offre en plus
 * une API par callbacks (abonnement) et un pont depuis un flux d'événements. Les deux
 * styles coexistent : on branche ce qui convient à chaque interface.
 */
import { EventEmitter } from "node:events";
import type { PipelineEvent, PipelineEventType } from "../types.js";

type Listener = (event: PipelineEvent) => void;

export class Monitor {
  private readonly emitter = new EventEmitter();

  /** Écoute tous les événements. Renvoie une fonction de désabonnement. */
  onAny(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Écoute un type d'événement précis. Renvoie une fonction de désabonnement. */
  on<T extends PipelineEventType>(
    type: T,
    listener: (event: Extract<PipelineEvent, { type: T }>) => void,
  ): () => void {
    const wrapped: Listener = (event) => {
      if (event.type === type) listener(event as Extract<PipelineEvent, { type: T }>);
    };
    this.emitter.on("event", wrapped);
    return () => this.emitter.off("event", wrapped);
  }

  emit(event: PipelineEvent): void {
    this.emitter.emit("event", event);
  }

  /**
   * Consomme un flux d'événements (celui de l'exécuteur) en les rediffusant aux
   * abonnés, et le ré-expose pour que l'appelant puisse aussi itérer dessus.
   */
  async *pipe(events: AsyncIterable<PipelineEvent>): AsyncGenerator<PipelineEvent> {
    for await (const event of events) {
      this.emit(event);
      yield event;
    }
  }
}

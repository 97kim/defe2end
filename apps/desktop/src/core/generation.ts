// Connection generation (stage 4 contract section 9): bumped on login, server change and account change.
// Everything started under one generation carries its number and its abort signal; once the number moves on,
// late callbacks and responses of the old one are dropped and its HTTP requests are cancelled.

export interface GenerationTicket {
  readonly id: number;
  readonly signal: AbortSignal;
  /** True while this is still the current generation. */
  current(): boolean;
}

export class Generations {
  private id = 0;
  private controller = new AbortController();

  ticket(): GenerationTicket {
    const id = this.id;
    const signal = this.controller.signal;
    return { id, signal, current: () => id === this.id };
  }

  /** Cancels the old generation's requests and starts a new one. */
  next(): GenerationTicket {
    this.controller.abort(new GenerationChangedError());
    this.controller = new AbortController();
    this.id++;
    return this.ticket();
  }

  /** Runs `fn` with the result only if the generation didn't change meanwhile. */
  guard<A extends unknown[]>(ticket: GenerationTicket, fn: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      if (ticket.current()) fn(...args);
    };
  }
}

export class GenerationChangedError extends Error {
  constructor() {
    super("The connection changed");
    this.name = "GenerationChangedError";
  }
}

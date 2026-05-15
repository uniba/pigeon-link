import { normalizeFilter } from "./filter.ts";

// Owns the listener bookkeeping for a single base event name (e.g. "pigeon:receive").
// Maps each user-supplied handler to the wrapped EventListener it was registered as,
// so that remove* calls can find and unregister the right listener.
export class MessageListenerRegistry<M extends { type: string }> {
  private map: Map<unknown, Map<string, EventListener>> = new Map();

  constructor(private baseEventName: string) {}

  public addString(
    type: string,
    handler: (message: M) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // Wildcard "*" subscribes to the empty filter (i.e. every message).
    const filter: Record<string, string> = type === "*" ? {} : { type };
    const eventName = `${this.baseEventName}:${normalizeFilter(filter)}`;

    const wrapped = this.register(handler, eventName);
    if (!wrapped) return;
    addEventListener(eventName, wrapped, options);
  }

  public addRegExp(
    regex: RegExp,
    handler: (message: M) => void,
  ): void {
    // RegExp filters subscribe to the all-messages event and filter internally.
    // Native EventAPI options (once / signal / etc) are intentionally not
    // supported here, because internal filtering would consume those options
    // on filtered-out messages. Use a string `type` if option support is needed.
    const eventName = `${this.baseEventName}:{}`;

    const wrapped = this.register(handler, eventName, regex);
    if (!wrapped) return;
    addEventListener(eventName, wrapped);
  }

  public removeString(
    type: string,
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const filter: Record<string, string> = type === "*" ? {} : { type };
    const eventName = `${this.baseEventName}:${normalizeFilter(filter)}`;
    this.unregister(eventName, handler, options);
  }

  public removeRegExp(handler: unknown): void {
    const eventName = `${this.baseEventName}:{}`;
    this.unregister(eventName, handler);
  }

  // Unregisters every wrapped listener this registry has added to the global
  // event target. Note: listeners registered with `capture: true` won't be
  // matched here; this is fine because capture has no meaning for our custom
  // events on the global EventTarget (no DOM hierarchy).
  public removeAll(): void {
    for (const typeMap of this.map.values()) {
      for (const [eventName, wrapped] of typeMap) {
        removeEventListener(eventName, wrapped);
      }
    }
    this.map.clear();
  }

  // Returns the wrapped listener to register, or null if the (handler, eventName)
  // pair is already registered (matches addEventListener semantics).
  private register(
    handler: (message: M) => void,
    eventName: string,
    regex?: RegExp,
  ): EventListener | null {
    let typeMap = this.map.get(handler);
    if (!typeMap) {
      typeMap = new Map();
      this.map.set(handler, typeMap);
    }
    if (typeMap.has(eventName)) return null;

    const baseEventName = this.baseEventName;
    const wrapped = (event: Event) => {
      const message = (event as CustomEvent<M>).detail;
      if (regex && !regex.test(message.type)) return;
      queueMicrotask(() => {
        try {
          handler(message);
        } catch (e) {
          console.error(`Error in ${baseEventName} handler:`, e);
        }
      });
    };
    typeMap.set(eventName, wrapped);
    return wrapped;
  }

  private unregister(
    eventName: string,
    handler: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    const typeMap = this.map.get(handler);
    if (!typeMap) return;

    const wrapped = typeMap.get(eventName);
    if (!wrapped) return;

    removeEventListener(eventName, wrapped, options);
    typeMap.delete(eventName);
    if (typeMap.size === 0) {
      this.map.delete(handler);
    }
  }
}

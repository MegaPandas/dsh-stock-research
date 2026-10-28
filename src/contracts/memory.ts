export interface MemoryRef {
  readonly entryId: string;
  readonly revision: number;
}

export type MemoryIndex<State extends object> = State & {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly entries: Readonly<Record<string, readonly number[]>>;
};

export interface MemoryWriter {
  entry(
    previous: MemoryRef | null,
    build: (ref: MemoryRef) => unknown,
  ): MemoryRef;
}

export class HistoryStack<T> {
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];

  constructor(
    private readonly clone: (value: T) => T,
    private readonly limit = 80,
  ) {}

  push(value: T): void {
    this.undoStack.push(this.clone(value));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(current: T): T | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(this.clone(current));
    return this.clone(previous);
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(this.clone(current));
    return this.clone(next);
  }
}
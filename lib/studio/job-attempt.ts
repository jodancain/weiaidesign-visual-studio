type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Persist before submission: a lost response must not become another paid job. */
export async function submitJobWithReceipt<T>(storage: AttemptStorage, intent: string, submit: (key: string) => Promise<T>, newKey: () => string = () => crypto.randomUUID()): Promise<T> {
  const slot = `studio-v3-pending-job:${intent}`;
  const key = storage.getItem(slot) || newKey();
  storage.setItem(slot, key);
  const receipt = await submit(key);
  if (storage.getItem(slot) === key) storage.removeItem(slot);
  return receipt;
}

type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file: (resolve: (file: File) => void, reject: (error: DOMException) => void) => void;
  createReader: () => { readEntries: (resolve: (entries: Entry[]) => void, reject: (error: DOMException) => void) => void };
};

export async function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  // Capture entries before the drop event ends, while the browser exposes them.
  const entries = Array.from(transfer.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry() as Entry | null);
  const fallback = Array.from(transfer.files);
  if (!entries.length || entries.some(entry => !entry)) return fallback;
  const files: File[] = [];
  async function read(entry: Entry, parent = ''): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: parent + file.name });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await read(child, `${parent}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await read(entry!);
  return files;
}

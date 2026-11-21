export function parseGuildStatus(content) {
  const html = content.formatted_body || '';
  const lines = html.match(/<li>[\s\S]*?<\/li>/g) || (content.body || '').split('\n');
  const result = new Map();
  for (const line of lines) {
    const plain = line.replace(/<[^>]*>/g, '');
    const match = plain.match(/\((\d{17,20})\)\s*-\s*(.+)/);
    if (match) result.set(match[1], match[2].trim());
  }
  return result;
}

export class DiscordImportQueue {
  constructor(ids, concurrency, statuses, adoptId) {
    this.ids = ids;
    this.concurrency = concurrency;
    this.completed = new Set();
    this.active = new Set();
    this.submitted = new Set();
    this.update(statuses);
    if (adoptId) {
      if (!ids.includes(adoptId)) throw new Error('The active server is outside the allowed import list.');
      if (!this.completed.has(adoptId)) this.active.add(adoptId);
    }
  }

  update(statuses) {
    for (const id of this.ids) {
      if (!statuses.has(id)) throw new Error('Server missing from bridge status: ' + id);
    }
    for (const id of this.ids) {
      if (statuses.get(id) === 'bridge all messages and create portals proactively') {
        this.completed.add(id);
        this.active.delete(id);
      }
    }
  }

  takeAvailable() {
    const next = [];
    for (const id of this.ids) {
      if (this.active.size >= this.concurrency) break;
      if (this.completed.has(id) || this.active.has(id) || this.submitted.has(id)) continue;
      this.active.add(id);
      this.submitted.add(id);
      next.push(id);
    }
    return next;
  }
}

export interface Link {
  slug: string;
  url: string;
  createdAt: number;
  clicks: number;
  lastClickedAt: number | null;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export class Store {
  private readonly links = new Map<string, Link>();

  create(url: string, now: number): Link {
    const link: Link = { slug: this.newSlug(), url, createdAt: now, clicks: 0, lastClickedAt: null };
    this.links.set(link.slug, link);
    return link;
  }

  get(slug: string): Link | undefined {
    return this.links.get(slug);
  }

  recordClick(link: Link, now: number): void {
    link.clicks += 1;
    link.lastClickedAt = now;
  }

  private newSlug(): string {
    for (;;) {
      let slug = "";
      for (let i = 0; i < 6; i++) slug += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      if (!this.links.has(slug)) return slug;
    }
  }
}

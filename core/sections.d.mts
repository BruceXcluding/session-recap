export type SectionKey = 'intent' | 'ideas' | 'changed' | 'open' | 'resume'
export declare const SECTIONS: { key: SectionKey; label: string; match: RegExp }[]
export declare function sectionsOf(markdown: string): Partial<Record<SectionKey, string>>

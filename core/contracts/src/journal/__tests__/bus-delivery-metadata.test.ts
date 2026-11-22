import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BusDeliveryMetadataSchema,
  ContributionNameSchema,
  MAKAIO_BUS_DELIVERY_READER,
  type BusDeliveryMetadata,
} from '@makaio/core';
import { JournalEntrySchema, type JournalEntry } from '../entry.js';
import { PositionSchema, type EntryId, type Position } from '../identifiers.js';

describe('bus delivery metadata alignment with the journal identifiers', () => {
  describe('types', () => {
    it('declares entryId and position as the journal identifier types', () => {
      expectTypeOf<BusDeliveryMetadata['entryId']>().toEqualTypeOf<EntryId>();
      expectTypeOf<BusDeliveryMetadata['position']>().toEqualTypeOf<Position>();
    });

    it('accepts the identifying fields of a journal entry as delivery metadata', () => {
      expectTypeOf<Pick<JournalEntry, 'entryId' | 'position'>>().toExtend<BusDeliveryMetadata>();
    });
  });

  describe('position boundary values', () => {
    it.each([
      { label: '0', value: 0, accepted: true },
      { label: '1', value: 1, accepted: true },
      { label: 'Number.MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER, accepted: true },
      { label: '-1', value: -1, accepted: false },
      { label: '0.5', value: 0.5, accepted: false },
      { label: 'Number.NaN', value: Number.NaN, accepted: false },
      { label: 'Number.POSITIVE_INFINITY', value: Number.POSITIVE_INFINITY, accepted: false },
      { label: "'1'", value: '1', accepted: false },
    ])('treats $label the same in both schemas (accepted: $accepted)', ({ value, accepted }) => {
      const journal = PositionSchema.safeParse(value).success;
      const delivery = BusDeliveryMetadataSchema.safeParse({ entryId: 'e1', position: value }).success;

      expect(journal).toBe(accepted);
      expect(delivery).toBe(accepted);
      expect(delivery).toBe(journal);
    });
  });

  describe('entryId boundary values', () => {
    it.each([
      { label: "'e1'", value: 'e1', accepted: true },
      { label: "''", value: '', accepted: false },
    ])('treats $label the same in both schemas (accepted: $accepted)', ({ value, accepted }) => {
      const journal = JournalEntrySchema.shape.entryId.safeParse(value).success;
      const delivery = BusDeliveryMetadataSchema.safeParse({ entryId: value, position: 0 }).success;

      expect(journal).toBe(accepted);
      expect(delivery).toBe(accepted);
      expect(delivery).toBe(journal);
    });
  });

  it('rejects an unknown extra key', () => {
    const result = BusDeliveryMetadataSchema.safeParse({ entryId: 'e1', position: 0, extra: true });

    expect(result.success).toBe(false);
  });

  describe('MAKAIO_BUS_DELIVERY_READER', () => {
    it('is the core reader name', () => {
      expect(MAKAIO_BUS_DELIVERY_READER).toBe('makaio.bus-delivery');
    });

    it('is a valid contribution name', () => {
      expect(ContributionNameSchema.safeParse(MAKAIO_BUS_DELIVERY_READER).success).toBe(true);
    });
  });
});

import { UnprocessableEntityException } from '@nestjs/common';
import { validateTransition, canEmployeeCancel } from '../../src/modules/requests/state-machine';
import { RequestStatus } from '../../src/modules/requests/request.entity';

describe('State Machine', () => {
  describe('validateTransition', () => {
    // ── Valid transitions ───────────────────────────────────────────────────
    it('allows DRAFT → PENDING', () => {
      expect(() => validateTransition(RequestStatus.DRAFT, RequestStatus.PENDING)).not.toThrow();
    });

    it('allows DRAFT → CANCELLED', () => {
      expect(() => validateTransition(RequestStatus.DRAFT, RequestStatus.CANCELLED)).not.toThrow();
    });

    it('allows PENDING → APPROVED', () => {
      expect(() => validateTransition(RequestStatus.PENDING, RequestStatus.APPROVED)).not.toThrow();
    });

    it('allows PENDING → REJECTED', () => {
      expect(() => validateTransition(RequestStatus.PENDING, RequestStatus.REJECTED)).not.toThrow();
    });

    it('allows PENDING → CANCELLED', () => {
      expect(() => validateTransition(RequestStatus.PENDING, RequestStatus.CANCELLED)).not.toThrow();
    });

    // ── Invalid transitions (terminal states) ───────────────────────────────
    it('throws 422 for APPROVED → PENDING (already approved)', () => {
      expect(() =>
        validateTransition(RequestStatus.APPROVED, RequestStatus.PENDING),
      ).toThrow(UnprocessableEntityException);
    });

    it('throws 422 for REJECTED → APPROVED', () => {
      expect(() =>
        validateTransition(RequestStatus.REJECTED, RequestStatus.APPROVED),
      ).toThrow(UnprocessableEntityException);
    });

    it('throws 422 for CANCELLED → PENDING', () => {
      expect(() =>
        validateTransition(RequestStatus.CANCELLED, RequestStatus.PENDING),
      ).toThrow(UnprocessableEntityException);
    });

    it('throws 422 for APPROVED → CANCELLED (cannot cancel approved)', () => {
      expect(() =>
        validateTransition(RequestStatus.APPROVED, RequestStatus.CANCELLED),
      ).toThrow(UnprocessableEntityException);
    });

    it('throws 422 for DRAFT → APPROVED (must go through PENDING)', () => {
      expect(() =>
        validateTransition(RequestStatus.DRAFT, RequestStatus.APPROVED),
      ).toThrow(UnprocessableEntityException);
    });
  });

  describe('canEmployeeCancel', () => {
    it('returns true for DRAFT', () => {
      expect(canEmployeeCancel(RequestStatus.DRAFT)).toBe(true);
    });

    it('returns true for PENDING', () => {
      expect(canEmployeeCancel(RequestStatus.PENDING)).toBe(true);
    });

    it('returns false for APPROVED', () => {
      expect(canEmployeeCancel(RequestStatus.APPROVED)).toBe(false);
    });

    it('returns false for REJECTED', () => {
      expect(canEmployeeCancel(RequestStatus.REJECTED)).toBe(false);
    });

    it('returns false for CANCELLED', () => {
      expect(canEmployeeCancel(RequestStatus.CANCELLED)).toBe(false);
    });
  });
});

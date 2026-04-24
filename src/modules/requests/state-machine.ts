import { RequestStatus } from './request.entity';
import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Valid state transitions for a TimeOffRequest.
 *
 * This is the single source of truth for the state machine.
 * Any code that changes status MUST call validateTransition() first.
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  [RequestStatus.DRAFT]: [RequestStatus.PENDING, RequestStatus.CANCELLED],
  [RequestStatus.PENDING]: [
    RequestStatus.APPROVED,
    RequestStatus.REJECTED,
    RequestStatus.CANCELLED,
  ],
  [RequestStatus.APPROVED]: [], // terminal
  [RequestStatus.REJECTED]: [], // terminal
  [RequestStatus.CANCELLED]: [], // terminal
};

export function validateTransition(
  from: RequestStatus,
  to: RequestStatus,
): void {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new UnprocessableEntityException(
      `Invalid status transition: ${from} → ${to}. Allowed: [${allowed.join(', ') || 'none'}]`,
    );
  }
}

export function canEmployeeCancel(status: RequestStatus): boolean {
  return status === RequestStatus.PENDING || status === RequestStatus.DRAFT;
}

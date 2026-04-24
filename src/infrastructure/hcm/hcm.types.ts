export interface HcmBalance {
  employeeId: string;
  locationId: string;
  leaveType: string;
  totalDays: number;
  usedDays: number;
  availableDays: number;
  lastModifiedAt: string;
}

export interface HcmFileRequestPayload {
  employeeId: string;
  locationId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface HcmFileRequestResponse {
  success: boolean;
  hcmRequestId: string;
  status: string;
  message?: string;
}

export interface HcmBatchRecord {
  employeeId: string;
  locationId: string;
  leaveType: string;
  totalDays: number;
  usedDays: number;
  lastModifiedAt: string;
}

export interface HcmBatchPayload {
  records: HcmBatchRecord[];
  generatedAt: string;
}

export interface HcmError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

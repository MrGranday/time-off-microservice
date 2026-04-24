import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export enum SyncType {
  REALTIME = 'REALTIME',
  BATCH = 'BATCH',
  WEBHOOK = 'WEBHOOK',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

export enum SyncTrigger {
  CRON = 'CRON',
  MANUAL = 'MANUAL',
  REQUEST = 'REQUEST',
  WEBHOOK = 'WEBHOOK',
}

@Entity('sync_logs')
export class SyncLog {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text', name: 'sync_type' })
  syncType: SyncType;

  @Column({ type: 'text', nullable: true, name: 'employee_id' })
  employeeId: string | null;

  @Column({ type: 'text', nullable: true, name: 'location_id' })
  locationId: string | null;

  @Column({ type: 'text', nullable: true, name: 'leave_type' })
  leaveType: string | null;

  @Column({ type: 'text' })
  status: SyncStatus;

  @Column({ type: 'integer', default: 0, name: 'records_synced' })
  recordsSynced: number;

  @Column({ type: 'text', nullable: true, name: 'error_detail' })
  errorDetail: string | null;

  @Column({ type: 'text', name: 'triggered_by' })
  triggeredBy: SyncTrigger;

  @Column({ type: 'integer', nullable: true, name: 'duration_ms' })
  durationMs: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}

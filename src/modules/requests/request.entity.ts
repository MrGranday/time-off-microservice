import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Check,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/user.entity';

export enum RequestStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_requests')
@Check(`"days_requested" > 0`)
export class TimeOffRequest {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text', name: 'employee_id' })
  employeeId: string;

  @Column({ type: 'text', name: 'location_id' })
  locationId: string;

  @Column({ type: 'text', name: 'leave_type' })
  leaveType: string;

  @Column({ type: 'text', name: 'start_date' })
  startDate: string; // ISO date string YYYY-MM-DD

  @Column({ type: 'text', name: 'end_date' })
  endDate: string;

  @Column({ type: 'real', name: 'days_requested' })
  daysRequested: number;

  @Column({ type: 'text', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'text', nullable: true, name: 'manager_id' })
  managerId: string | null;

  @Column({ type: 'text', nullable: true, name: 'manager_note' })
  managerNote: string | null;

  @Column({ type: 'text', nullable: true, name: 'approved_by' })
  approvedBy: string | null;

  @Column({ type: 'datetime', nullable: true, name: 'reviewed_at' })
  reviewedAt: Date | null;

  /** Reference ID assigned by the HCM system after successful filing */
  @Column({ type: 'text', nullable: true, name: 'hcm_request_id' })
  hcmRequestId: string | null;

  /** Last known status from HCM */
  @Column({ type: 'text', nullable: true, name: 'hcm_status' })
  hcmStatus: string | null;

  /** Raw error message from HCM, for debugging */
  @Column({ type: 'text', nullable: true, name: 'hcm_error' })
  hcmError: string | null;

  /**
   * Client-provided idempotency key. Stored with UNIQUE constraint so that
   * retried requests with the same key return the original record instead of
   * creating a duplicate.
   */
  @Column({
    type: 'text',
    nullable: true,
    unique: true,
    name: 'idempotency_key',
  })
  idempotencyKey: string | null;

  @Column({ type: 'integer', default: 1 })
  version: number;

  @ManyToOne(() => User, (user) => user.timeOffRequests, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'employee_id' })
  employee: User;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'manager_id' })
  manager: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}

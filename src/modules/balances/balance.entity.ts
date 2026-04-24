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

export enum LeaveType {
  ANNUAL = 'ANNUAL',
  SICK = 'SICK',
  MATERNITY = 'MATERNITY',
  PATERNITY = 'PATERNITY',
  UNPAID = 'UNPAID',
  EMERGENCY = 'EMERGENCY',
}

@Entity('leave_balances')
@Check(`"total_days" >= 0`)
@Check(`"used_days" >= 0`)
@Check(`"used_days" <= "total_days"`)
export class LeaveBalance {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text', name: 'employee_id' })
  employeeId: string;

  @Column({ type: 'text', name: 'location_id' })
  locationId: string;

  @Column({ type: 'text', name: 'leave_type' })
  leaveType: LeaveType;

  @Column({ type: 'real', name: 'total_days', default: 0 })
  totalDays: number;

  @Column({ type: 'real', name: 'used_days', default: 0 })
  usedDays: number;

  /**
   * Optimistic lock version — MUST be included in every UPDATE WHERE clause.
   * If the row was modified between our read and write, the update returns 0
   * affected rows and we retry or throw 409 Conflict.
   */
  @Column({ type: 'integer', name: 'version', default: 1 })
  version: number;

  @Column({ type: 'datetime', nullable: true, name: 'last_synced_at' })
  lastSyncedAt: Date | null;

  @Column({ type: 'boolean', name: 'hcm_synced', default: false })
  hcmSynced: boolean;

  @ManyToOne(() => User, (user) => user.leaveBalances, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Computed: available days — never stored, always derived
  get availableDays(): number {
    return Math.max(0, this.totalDays - this.usedDays);
  }

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}

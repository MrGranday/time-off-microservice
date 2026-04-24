import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export enum AuditEntityType {
  BALANCE = 'BALANCE',
  REQUEST = 'REQUEST',
  USER = 'USER',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text', name: 'entity_type' })
  entityType: AuditEntityType;

  @Column({ type: 'text', name: 'entity_id' })
  entityId: string;

  @Column({ type: 'text', name: 'actor_id' })
  actorId: string;

  @Column({ type: 'text', name: 'actor_email', nullable: true })
  actorEmail: string | null;

  @Column({ type: 'text' })
  action: string;

  /** JSON snapshot of the entity before the change */
  @Column({ type: 'text', nullable: true, name: 'old_value' })
  oldValue: string | null;

  /** JSON snapshot of the entity after the change */
  @Column({ type: 'text', nullable: true, name: 'new_value' })
  newValue: string | null;

  @Column({ type: 'text', nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}

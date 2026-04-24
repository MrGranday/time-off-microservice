import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TimeOffRequest } from '../requests/request.entity';
import { LeaveBalance } from '../balances/balance.entity';

export enum UserRole {
  EMPLOYEE = 'EMPLOYEE',
  MANAGER = 'MANAGER',
  ADMIN = 'ADMIN',
}

@Entity('users')
export class User {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', select: false }) // never returned by default
  password: string;

  @Column({ type: 'text', default: UserRole.EMPLOYEE })
  role: UserRole;

  @Column({ type: 'text', nullable: true, name: 'manager_id' })
  managerId: string | null;

  @Column({ type: 'text', nullable: true, name: 'location_id' })
  locationId: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @ManyToOne(() => User, (user) => user.subordinates, { nullable: true })
  @JoinColumn({ name: 'manager_id' })
  manager: User;

  @OneToMany(() => User, (user) => user.manager)
  subordinates: User[];

  @OneToMany(() => TimeOffRequest, (req) => req.employee)
  timeOffRequests: TimeOffRequest[];

  @OneToMany(() => LeaveBalance, (bal) => bal.employee)
  leaveBalances: LeaveBalance[];

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

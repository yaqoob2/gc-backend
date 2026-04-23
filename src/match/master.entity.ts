import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('master')
export class Master {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'product_name' })
    productName: string;

    @Column({ name: 'vendor_name', nullable: true })
    vendorName: string;

    @Column({ name: 'company', nullable: true })
    company: string;

    @Column({ name: 'packing', nullable: true })
    packing: string;

    @Column({ name: 'avg_rate', type: 'decimal', nullable: true })
    avgRate: number;
}
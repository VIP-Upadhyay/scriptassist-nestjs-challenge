import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddRefreshTokensAndUserEnhancements1750650800000 implements MigrationInterface {
  name = 'AddRefreshTokensAndUserEnhancements1750650800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add new columns to users table
    await queryRunner.query(`
      ALTER TABLE "users" 
      ADD COLUMN "isLocked" boolean NOT NULL DEFAULT false,
      ADD COLUMN "suspendedUntil" timestamp,
      ADD COLUMN "lastLoginAt" timestamp,
      ADD COLUMN "lastLoginIp" varchar(45),
      ADD COLUMN "failedLoginAttempts" integer NOT NULL DEFAULT 0,
      ADD COLUMN "lockedUntil" timestamp
    `);

    // Create refresh_tokens table
    await queryRunner.createTable(
      new Table({
        name: 'refresh_tokens',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'token',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'userId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'expiresAt',
            type: 'timestamp',
            isNullable: false,
          },
          {
            name: 'isRevoked',
            type: 'boolean',
            default: false,
          },
          {
            name: 'userAgent',
            type: 'varchar',
            length: '500',
            isNullable: true,
          },
          {
            name: 'ipAddress',
            type: 'varchar',
            length: '45',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
        foreignKeys: [
          {
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
        indices: [
          {
            name: 'IDX_refresh_tokens_token',
            columnNames: ['token'],
          },
          {
            name: 'IDX_refresh_tokens_userId_isRevoked',
            columnNames: ['userId', 'isRevoked'],
          },
          {
            name: 'IDX_refresh_tokens_expiresAt',
            columnNames: ['expiresAt'],
          },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop refresh_tokens table
    await queryRunner.dropTable('refresh_tokens');

    // Remove added columns from users table
    await queryRunner.query(`
      ALTER TABLE "users" 
      DROP COLUMN "isLocked",
      DROP COLUMN "suspendedUntil",
      DROP COLUMN "lastLoginAt",
      DROP COLUMN "lastLoginIp",
      DROP COLUMN "failedLoginAttempts",
      DROP COLUMN "lockedUntil"
    `);
  }
}
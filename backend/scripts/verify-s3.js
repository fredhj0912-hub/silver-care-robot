#!/usr/bin/env node
/**
 * S3 스냅샷 저장이 실제로 되는지 빠르게 확인하는 스모크 테스트.
 *
 *   node backend/scripts/verify-s3.js
 *
 * 로컬(Windows 개발 환경)에서 SNAPSHOT_STORAGE=s3로 실행하면 대회 AWS 계정이 Access Key
 * 발급을 금지하고 있어 항상 실패하는 게 정상이다 — 실제 확인은 SafeInstanceProfile-
 * {username}이 붙은 EC2 인스턴스에서 실행해야 한다. (docs/deploy-ec2-aws-test.md 참고)
 * SNAPSHOT_STORAGE=local(기본값)이면 로컬 파일 왕복만 확인한다.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const snapshots = require('../src/services/snapshots');

// 1x1 투명 PNG
const DUMMY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
  console.log(`저장소: ${config.snapshotStorage}${config.snapshotStorage === 's3' ? ` (버킷: ${config.s3Bucket || '(미설정)'}, 리전: ${config.awsRegion})` : ''}`);

  try {
    const name = await snapshots.save(DUMMY_PNG);
    if (!name) {
      console.log('❌ 저장 실패 — save()가 null을 반환했습니다 (데이터 URI 형식 문제)');
      return;
    }

    if (config.snapshotStorage === 's3') {
      const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
      const client = new S3Client({ region: config.awsRegion });
      await client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: name }));
      console.log(`✅ S3 저장·조회 성공: s3://${config.s3Bucket}/${name}`);
    } else {
      const full = path.join(config.snapshotDir, name);
      if (!fs.existsSync(full)) throw new Error(`저장했다는 파일이 실제로 없습니다: ${full}`);
      console.log(`✅ 로컬 저장·조회 성공: ${full}`);
    }
  } catch (err) {
    console.log('❌ 실패:', err.message);
    console.log('   확인할 것:');
    console.log('   - SNAPSHOT_STORAGE=s3 라면 S3_BUCKET/AWS_REGION이 .env에 설정돼 있는지');
    console.log('   - EC2 인스턴스에 SafeInstanceProfile-{username}이 붙어있는지');
    console.log('   - 그 역할에 s3:PutObject/s3:GetObject 권한이 있는지');
    console.log('   - 버킷 이름이 실제로 존재하고 본인 username으로 시작하는지');
  }
}

main();

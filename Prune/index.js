const AWS = require('aws-sdk');
const Route53 = new AWS.Route53();
const DB = new AWS.DynamoDB();

const HOSTEDZONEID = "Z3PPKLB0ZXZ4HB";
const DBNAME = "MinkeDNS";
const PRUNE_TIME = 7 * 1000 * 60 * 60 * 24; // 7 days
const MAX_DB_CHANGES = 25;
const MAX_DNS_CHANGES = 64; // Must be power of 2

exports.handler = async () => {
    let data = { next: true };
    while (data.next) {
      data = await findPrunes(data.next);
      const dns = [];
      const prunes = [];
      data.items.forEach(item => {
        prunes.push(item.Host);
        const name = item.Host.S + '.minkebox.net.';
        dns.push({
          Action: "DELETE", 
          ResourceRecordSet: {
            Name: name, 
            ResourceRecords: [ { Value: item.Ip.S } ],
            TTL: 600, 
            Type: "A"
          }
        });
        if (item['Ip6'].S != '::') {
          dns.push({
            Action: "DELETE", 
            ResourceRecordSet: {
              Name: name, 
              ResourceRecords: [ { Value: item.Ip6.S } ],
              TTL: 600, 
              Type: "AAAA"
            }
          });
        }
      });
      await pruneDNS(dns, MAX_DNS_CHANGES);
      await pruneDB(prunes);
    }
    return { statusCode: 200, body: '' };
};

async function findPrunes(start) {
  return new Promise((resolve, reject) => {
    const params = {
      TableName: DBNAME,
      FilterExpression: 'Updated < :when',
      ExpressionAttributeValues: {
        ':when': { N: `${Date.now() - PRUNE_TIME}` }
      },
      Select: 'ALL_ATTRIBUTES'
    };
    if (start !== true) {
      params.ExclusiveStartKey = start;
    }
    DB.scan(params, (err, data) => {
      if (err) {
        return reject (err);
      }
      resolve({ items: data.Items, next: data.LastEvaluatedKey });
    });
  });
}

function chunks(items, size) {
  const groups = [];
  let group = [];
  items.forEach(key => {
    group.push(key);
    if (group.length >= size) {
      groups.push(group);
      group = [];
    }
  });
  if (group.length) {
    groups.push(group);
  }
  return groups;
}

async function pruneDB(keys) {
  return Promise.all(chunks(keys, MAX_DB_CHANGES).map(async (chunk) => {
    return pruneDBGroup(chunk);
  }));
}

async function pruneDBGroup(keys) {
  return new Promise((resolve, reject) => {
    DB.batchWriteItem({
      RequestItems: {
        [DBNAME]: keys.map(key => {
          return { DeleteRequest: { Key: { Host: key } } }
        })
      }
    }, (err, data) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

async function pruneDNS(changes, size) {
   return Promise.all(chunks(changes, size).map(async (chunk) => {
    return pruneDNSGroup(chunk);
  }));
}

async function pruneDNSGroup(changes) {
  return new Promise((resolve, reject) => {
    Route53.changeResourceRecordSets({
      HostedZoneId: HOSTEDZONEID,
      ChangeBatch: {
        Changes: changes
      }
    }, (err, data) => {
      if (err) {
        if (err.code !== 'InvalidChangeBatch') {
          return reject(err);
        }
        if (changes.length === 1) {
          // Record alrady deleted. Keep going
          return resolve();
        }
        else {
          // We dont know which DELETE failed, so we split the group and retry. Maybe there's a better way?
          return pruneDNS(changes, Math.floor(changes.length / 2)).then(() => {
            resolve();
          });
        }
      }
      resolve();
    });
  });
}

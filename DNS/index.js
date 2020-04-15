const AWS = require('aws-sdk');
const Route53 = new AWS.Route53();
const DB = new AWS.DynamoDB();

const HOSTEDZONEID = "...";
const DBNAME = "MinkeDNS";
const DBHUMAN = "MinkeHuman";
const DBUIPINDEX = "UpdatingIp-index";
const LIMIT = 50;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPADDR = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPADDR6 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

exports.handler = async (event, context) => {

  //console.log(event.key, event.host, event.ip, event.ip6);

  const client = event.key;
  const host = event.host;
  const ip = event.ip;
  const ip6 = event.ip6;
  const uip = event.sourceIp;

  if (!IPADDR.test(ip)) {
    return 'fail';
  }
  if (ip6 && !IPADDR6.test(ip6)) {
    return 'fail';
  }
  if (!GUID.test(host)) {
    return 'fail';
  }
  if (!GUID.test(client)) {
    return 'fail';
  }

  await new Promise((resolve, reject) => {
    DB.getItem({
      TableName: DBHUMAN,
      Key: {
        Client: { S: client }
      }
    }, (err, data) => {
      if (err) {
        return reject(err);
      }
      const human = data && data.Item && data.Item.Human && data.Item.Human.S;
      if (!human) {
        return reject('not human');
      }
      resolve();
    });
  });

  const name = `${host}.minkebox.net.`;

  return new Promise((resolve, reject) => {
    DB.getItem({
      TableName: DBNAME,
      Key: {
        Host: { S: host }
      }
    }, (err, data) => {
      if (err) {
        return reject(err);
      }
      const dclient = data && data.Item && data.Item.Client && data.Item.Client.S;
      if (dclient && dclient !== client) {
        // Can only create new items, or update items with the same key
        return reject('key fail');
      }
      const duip = data && data.Item && data.Item.UpdatingIp && data.Item.UpdatingIp.S;
      if (duip == uip) {
        // Updating from the same IP
        return resolve();
      }
      // Updating from a different ip, or creating a new entry. Limit this.
      DB.query({
        TableName: DBNAME,
        IndexName: DBUIPINDEX,
        Select: 'COUNT',
        KeyConditionExpression: 'UpdatingIp = :uip',
        ExpressionAttributeValues: {
          ':uip': { S: uip }
        }
      }, (err, data) => {
        if (err) {
          return reject(err);
        }
        if (data.Count > LIMIT) {
          return reject('limit');
        }
        resolve();
      });
    });
  }).then(() => {
    return new Promise((resolve, reject) => {
      const args = {
        HostedZoneId: HOSTEDZONEID,
        ChangeBatch: {
          Changes: [{
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: name,
              ResourceRecords: [ { Value: ip } ],
              TTL: 600,
              Type: "A"
            }
          }]
        }
      };
      if (ip6) {
        args.ChangeBatch.Changes.push({
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: name,
            ResourceRecords: [ { Value: ip6 } ],
            TTL: 600,
            Type: "AAAA"
          }
        });
      }
      Route53.changeResourceRecordSets(args, (err, data) => {
        if (err) {
          return reject('fail.1');
        }
        if (!ip6) {
          const name = `${host}.minkebox.net.`;
          Route53.listResourceRecordSets({
            HostedZoneId: HOSTEDZONEID,
            StartRecordName: name,
            StartRecordType: 'AAAA'
          }, (err, data) => {
            if (err) {
              return reject(err);
            }
            const record = data.ResourceRecordSets[0];
            if (record && record.Name === name && record.Type === 'AAAA') {
              Route53.changeResourceRecordSets({
                HostedZoneId: HOSTEDZONEID,
                ChangeBatch: {
                  Changes: [{
                    Action: "DELETE",
                    ResourceRecordSet: record
                  }]
                }
              }, (err, data) => {
                if (err) {
                  return reject(err);
                }
                resolve('success.3');
              });
            }
            else {
              resolve('success.2');
            }
          });
        }
        else {
          resolve('success.1');
        }
      });
    });
  }).then(() => {
    return new Promise((resolve, reject) => {
      DB.updateItem({
        TableName: DBNAME,
        Key: {
          Host: { S: host }
        },
        UpdateExpression: `SET Client = :client, Ip = :ip, Ip6 = :ip6, Created = if_not_exists(Created, :now), UpdatingIp = :uip, Updated = :now`,
        ExpressionAttributeValues: {
          ':client': { S: client },
          ':ip': { S: ip },
          ':ip6': { S: ip6 || "::" },
          ':now': { N: `${Date.now()}` },
          ':uip': { S: uip || "__unknown" }
        },
      }, (err, data) => {
        if (err) {
          return reject(err);
        }
        resolve('success.4');
      });
    });
  });
};

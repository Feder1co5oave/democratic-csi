const cp = require("child_process");
const { hostname_lookup, sleep } = require("./general");
const net = require("net");

function getIscsiValue(value) {
  if (value == "<empty>") return null;
  return value;
}

const DEFAULT_TIMEOUT = process.env.ISCSI_DEFAULT_TIMEOUT || 30000;

class ISCSI {
  constructor(options = {}) {
    const iscsi = this;
    iscsi.options = options;

    options.paths = options.paths || {};
    if (!options.paths.iscsiadm) {
      options.paths.iscsiadm = "iscsiadm";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }

    iscsi.iscsiadm = {
      /**
       * iscsiadm -m iface -o show
       * iface_name transport_name,hwaddress,ipaddress,net_ifacename,initiatorname
       */
      async listInterfaces() {
        let args = [];
        args = args.concat(["-m", "iface", "-o", "show"]);
        const result = await iscsi.exec(options.paths.iscsiadm, args);

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        const entries = result.stdout.trim().split("\n");
        const interfaces = [];
        let fields;
        entries.forEach((entry) => {
          fields = entry.split(" ");
          interfaces.push({
            iface_name: fields[0],
            transport_name: fields[1].split(",")[0],
            hwaddress: getIscsiValue(fields[1].split(",")[1]),
            ipaddress: getIscsiValue(fields[1].split(",")[2]),
            net_ifacename: getIscsiValue(fields[1].split(",")[3]),
            initiatorname: getIscsiValue(fields[1].split(",")[4]),
          });
        });

        return interfaces;
      },

      /**
       * iscsiadm -m iface -o show -I <iface>
       *
       * @param {*} iface
       */
      async showInterface(iface) {
        let args = [];
        args = args.concat(["-m", "iface", "-o", "show", "-I", iface]);
        let result = await iscsi.exec(options.paths.iscsiadm, args);

        const entries = result.stdout.trim().split("\n");
        const i = {};
        let fields, key, value;
        entries.forEach((entry) => {
          if (entry.startsWith("#")) return;
          fields = entry.split("=");
          key = fields[0].trim();
          value = fields[1].trim();
          i[key] = getIscsiValue(value);
        });

        return i;
      },

      /**
       * iscsiadm --mode node -T <target> -p <portal> -o new
       *
       * @param {*} tgtIQN
       * @param {*} portal
       * @param {*} attributes
       */
      async createNodeDBEntry(tgtIQN, portal, attributes = {}) {
        let args = [];
        args = args.concat([
          "-m",
          "node",
          "-T",
          tgtIQN,
          "-p",
          portal,
          "-o",
          "new",
        ]);
        // create DB entry
        await iscsi.exec(options.paths.iscsiadm, args);

        // update attributes 1 by 1
        for (let attribute in attributes) {
          let args = [];
          args = args.concat([
            "-m",
            "node",
            "-T",
            tgtIQN,
            "-p",
            portal,
            "-o",
            "update",
            "--name",
            attribute,
            "--value",
            attributes[attribute],
          ]);
          // https://bugzilla.redhat.com/show_bug.cgi?id=884427
          // Could not execute operation on all records: encountered iSCSI database failure
          let retries = 0;
          let maxRetries = 5;
          let retryWait = 1000;
          while (retries < maxRetries) {
            retries++;
            try {
              //throw {stderr: "Could not execute operation on all records: encountered iSCSI database failure"};
              await iscsi.exec(options.paths.iscsiadm, args);
              break;
            } catch (err) {
              if (
                retries < maxRetries &&
                err.stderr.includes(
                  "Could not execute operation on all records: encountered iSCSI database failure"
                )
              ) {
                await sleep(retryWait);
              } else {
                throw err;
              }
            }
          }
        }
      },

      /**
       * iscsiadm --mode node -T <target> -p <portal> -o delete
       *
       * @param {*} tgtIQN
       * @param {*} portal
       */
      async deleteNodeDBEntry(tgtIQN, portal) {
        let args = [];
        args = args.concat([
          "-m",
          "node",
          "-T",
          tgtIQN,
          "-p",
          portal,
          "-o",
          "delete",
        ]);
        await iscsi.exec(options.paths.iscsiadm, args);
      },

      /**
       * get session object by iqn/portal
       */
      async getSession(tgtIQN, portal) {
        const sessions = await iscsi.iscsiadm.getSessions();

        let parsedPortal = iscsi.parsePortal(portal);
        let parsedPortalHostIP = "";
        if (parsedPortal.host) {
          // if host is not an ip address
          if (net.isIP(parsedPortal.host) == 0) {
            // ipv6 response is without []
            parsedPortalHostIP =
              (await hostname_lookup(parsedPortal.host)) || "";
          }
        }

        // set invalid hostname/ip string to ensure empty values do not errantly pass
        if (!parsedPortalHostIP) {
          parsedPortalHostIP = "--------------------------------------";
        }
        let session = false;
        sessions.every((i_session) => {
          // [2a10:4741:36:28:e61d:2dff:fe90:80fe]:3260
          // i_session.portal includes [] for ipv6
          if (
            `${i_session.iqn}` == tgtIQN &&
            (portal == i_session.portal ||
              `${parsedPortal.host}:${parsedPortal.port}` == i_session.portal ||
              `${parsedPortalHostIP}:${parsedPortal.port}` ==
                i_session.portal ||
              `[${parsedPortal.host}]:${parsedPortal.port}` ==
                i_session.portal ||
              `[${parsedPortalHostIP}]:${parsedPortal.port}` ==
                i_session.portal)
          ) {
            session = i_session;
            return false;
          }
          return true;
        });

        return session;
      },

      /**
       * iscsiadm -m session
       */
      async getSessions() {
        let args = [];
        args = args.concat(["-m", "session"]);
        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // no active sessions
          if (err.code == 21) {
            result = err;
          } else {
            throw err;
          }
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        // protocol: [id] ip:port,target_portal_group_tag targetname
        // tcp: [111] [2001:123:456::1]:3260,1 iqn.2005-10.org.freenas.ctl:default-aptcacher-iscsi-claim (non-flash)
        // tcp: [111] [hostname]:3260,1 iqn.2005-10.org.freenas.ctl:default-aptcacher-iscsi-claim (non-flash)
        let data;
        data = result.stdout;
        if (!data) {
          data = "";
        }
        const entries = data.trim().split("\n");
        const sessions = [];
        let fields;
        entries.forEach((entry) => {
          if (!entry) {
            return;
          }
          fields = entry.split(" ");
          sessions.push({
            protocol: entry.split(":")[0],
            id: Number(fields[1].replace("[", "").replace("]", "")),
            portal: fields[2].split(",")[0],
            target_portal_group_tag: fields[2].split(",")[1],
            iqn: fields[3].trim(),
            //iqn: fields[3].split(":")[0],
            //target: fields[3].split(":")[1],
          });
        });

        return sessions;
      },

      /**
       * iscsiadm -m session
       */
      async getSessionsDetails() {
        let args = [];
        args = args.concat(["-m", "session", "-P", "3"]);
        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // no active sessions
          if (err.code == 21) {
            result = err;
          } else {
            throw err;
          }
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        let currentTarget;
        let sessionGroups = [];
        let currentSession = [];

        // protocol: [id] ip:port,target_portal_group_tag targetname
        const entries = result.stdout.trim().split("\n");
        // remove first 2 lines
        entries.shift();
        entries.shift();

        // this should break up the lines into groups of lines
        // where each group is the full details of a single session
        // note that the output of the command bundles/groups all sessions
        // by target so extra logic is needed to hanle that
        // alternatively we could get all sessions using getSessions()
        // and then invoke `iscsiadm -m session -P 3 -r <session id>` in a loop
        for (let i = 0; i < entries.length; i++) {
          let entry = entries[i];
          if (entry.startsWith("Target:")) {
            currentTarget = entry;
          } else if (entry.trim().startsWith("Current Portal:")) {
            if (currentSession.length > 0) {
              sessionGroups.push(currentSession);
            }
            currentSession = [currentTarget, entry];
          } else {
            currentSession.push(entry);
          }
          if (i + 1 == entries.length) {
            sessionGroups.push(currentSession);
          }
        }

        const sessions = [];
        for (let i = 0; i < sessionGroups.length; i++) {
          let sessionLines = sessionGroups[i];
          let session = {};
          let currentSection;
          for (let j = 0; j < sessionLines.length; j++) {
            let line = sessionLines[j].trim();

            let uniqueChars = String.prototype.concat(...new Set(line));
            if (uniqueChars == "*") {
              currentSection = sessionLines[j + 1]
                .trim()
                .toLowerCase()
                .replace(/ /g, "_")
                .replace(/\W/g, "");
              j++;
              j++;
              continue;
            }

            let key = line
              .split(":", 1)[0]
              .trim()
              .replace(/ /g, "_")
              .replace(/\W/g, "");
            let value = line.split(":").slice(1).join(":").trim();

            if (currentSection) {
              session[currentSection] = session[currentSection] || {};
              switch (currentSection) {
                case "attached_scsi_devices":
                  key = key.toLowerCase();
                  if (key == "host_number") {
                    session[currentSection]["host"] = {
                      number: value.split("\t")[0],
                      state: value
                        .split("\t")
                        .slice(1)
                        .join("\t")
                        .split(":")
                        .slice(1)
                        .join(":")
                        .trim(),
                    };
                    while (
                      sessionLines[j + 1] &&
                      sessionLines[j + 1].trim().startsWith("scsi")
                    ) {
                      session[currentSection]["host"]["devices"] =
                        session[currentSection]["host"]["devices"] || [];
                      let line1p = sessionLines[j + 1].split(" ");
                      let line2 = sessionLines[j + 2];
                      let line2p = "";
                      if (line2) {
                        line2p = line2.split(" ");
                        session[currentSection]["host"]["devices"].push({
                          channel: line1p[2],
                          id: line1p[4],
                          lun: line1p[6],
                          attached_scsi_disk: line2p[3].split("\t")[0],
                          state: line2
                            .trim()
                            .split("\t")
                            .slice(1)
                            .join("\t")
                            .split(":")
                            .slice(1)
                            .join(":")
                            .trim(),
                        });
                      }

                      j++;
                      j++;
                    }
                    continue;
                  }
                  break;
                case "negotiated_iscsi_params":
                  key = key.charAt(0).toLowerCase() + key.slice(1);
                  key = key.replace(
                    /[A-Z]/g,
                    (letter) => `_${letter.toLowerCase()}`
                  );
                  break;
              }
              key = key.toLowerCase();
              session[currentSection][key] = value;
            } else {
              key = key.toLowerCase();
              if (key == "target") {
                value = value.split(" ")[0];
              }
              session[key.trim()] = value.trim();
            }
          }
          sessions.push(session);
        }

        return sessions;
      },

      /**
       * iscsiadm -m discovery -t st -p <portal>
       *
       * @param {*} portal
       */
      async discoverTargets(portal) {
        let args = [];
        args = args.concat(["-m", "discovery"]);
        args = args.concat(["-t", "sendtargets"]);
        args = args.concat(["-p", portal]);

        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          throw err;
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        const entries = result.stdout.trim().split("\n");
        const targets = [];
        entries.forEach((entry) => {
          targets.push({
            portal: entry.split(",")[0],
            target_portal_group_tag: entry.split(" ")[0].split(",")[1],
            iqn: entry.split(" ")[1].split(":")[0],
            target: entry.split(" ")[1].split(":")[1],
          });
        });

        return targets;
      },

      /**
       * iscsiadm -m node -T <target> -p <portal> -l
       *
       * @param {*} tgtIQN
       * @param {*} portal
       */
      async login(tgtIQN, portal) {
        let args = [];
        args = args.concat(["-m", "node", "-T", tgtIQN, "-p", portal, "-l"]);

        try {
          await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // already logged in
          if (err.code == 15) {
            return true;
          }
          throw err;
        }

        return true;
      },

      /**
       *
       *
       * @param {*} tgtIQN
       * @param {*} portals
       */
      async logout(tgtIQN, portals) {
        let args = [];
        args = args.concat(["-m", "node", "-T", tgtIQN]);

        if (!Array.isArray(portals)) {
          portals = [portals];
        }
        for (let i = 0; i < portals.length; i++) {
          let p = portals[i];
          try {
            await iscsi.exec(
              options.paths.iscsiadm,
              args.concat(["-p", p, "-u"])
            );
          } catch (err) {
            if (err.code == 21) {
              // no matching sessions
            } else {
              throw err;
            }
          }
        }

        return true;
      },

      /**
       * iscsiadm -m session -r SID --rescan
       *
       * @param {*} session
       */
      async rescanSession(session) {
        let sid;
        if (typeof session === "object") {
          sid = session.id;
        } else {
          sid = session;
        }

        // make sure session is a valid number
        if (session !== 0 && session > 0) {
          throw new Error("cannot scan empty session id");
        }

        let args = [];
        args = args.concat(["-m", "session", "-r", sid, "--rescan"]);

        try {
          await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          throw err;
        }

        return true;
      },
    };
  }

  parsePortal(portal) {
    portal = portal.trim();
    let host = null;
    let port = null;

    // ipv6
    if (portal.startsWith("[")) {
      host = portal.substr(0, portal.indexOf("]") + 1);
      port = portal.substr(portal.indexOf("]") + 2);
    } else {
      const lastIndex = portal.lastIndexOf(":");

      if (lastIndex !== -1) {
        host = portal.slice(0, lastIndex);
        port = portal.slice(lastIndex + 1);
      } else {
        host = portal;
      }
    }

    if (!port) {
      port = 3260;
    }

    return {
      host,
      port: parseInt(port),
    };
  }

  async devicePathByPortalIQNLUN(portal, iqn, lun, options = {}) {
    const parsedPortal = this.parsePortal(portal);
    let portalHost = parsedPortal.host.replaceAll("[", "").replaceAll("]", "");
    if (options.hostname_lookup && net.isIP(portalHost) == 0) {
      portalHost = (await hostname_lookup(portalHost)) || portalHost;
    }
    return `/dev/disk/by-path/ip-${portalHost}:${parsedPortal.port}-iscsi-${iqn}-lun-${lun}`;
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const iscsi = this;
    args = args || [];

    if (iscsi.options.sudo) {
      args.unshift(command);
      command = iscsi.options.paths.sudo;
    }
    console.log("executing iscsi command: %s %s", command, args.join(" "));

    return new Promise((resolve, reject) => {
      const child = iscsi.options.executor.spawn(command, args, options);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr, timeout: false };

        // timeout scenario
        if (code === null) {
          result.timeout = true;
          reject(result);
        }

        if (code) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports.ISCSI = ISCSI;

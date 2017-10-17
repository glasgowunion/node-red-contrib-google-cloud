// Copyright 2017 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

module.exports = function(RED) {
    "use strict";

    const STATUS_CONNECTED = {
        fill: "green",
        shape: "dot",
        text: "connected"
    };

    const STATUS_DISCONNECTED = {
        fill: "red",
        shape: "dot",
        text: "disconnected"
    };

    const STATUS_CONNECTING = {
        fill: "yellow",
        shape: "dot",
        text: "connecting"
    };

    const STATUS_PUBLISHING = {
        fill: "green",
        shape: "ring",
        text: "publishing"
    };

    const PubSub = require("@google-cloud/pubsub");

    /**
     * Extract JSON service account key from "google-cloud-credentials" config node.
     */
    function GetCredentials(node) {
        return JSON.parse(RED.nodes.getCredentials(node).account);
    }

    /**
     * Attempt to translate MQTT-like messages to PubSub.
     */
    function MqttToPubSub(message) {
        const date = new Date(message.time || Date.now());
        return {
            data: message.payload,
            attributes: {
                timestamp: date.toISOString()
            }
        };
    }

    /**
     * Attempt to translate PubSub messages to MQTT-like.
     */
    function PubSubToMqtt(subscription,binary, topic, message) {
        const path = subscription.id.split("/");
        var msg = "";
        if binary === "binary" {
            msg = new Buffer(message.data);
        }
        if binary === "string" {
            msg = message.data;
        }
        return {
            payload: msg,
            time: Date.parse(message.timestamp),
            project: path[path.length - 3],
            topic: topic,
            subscription: path[path.length - 1],
            resource: subscription.id
        };
    }

    function GoogleCloudPubSubInNode(config) {
        RED.nodes.createNode(this, config);

        const node = this,
              credentials = GetCredentials(config.account),
              state = {
                  pubsub: null,
                  topic: null,
                  subscription: null,
                  autogenerated: null,
                  done: null
              };

        node.status(STATUS_DISCONNECTED);

        function OnMessage(message) {
            if (message == null)
                return;
            node.send(PubSubToMqtt(state.subscription, config.binary,config.topic, message));
            message.ack();
        }

        function OnError(error) {
            if (error == null)
                return;
            node.status(STATUS_DISCONNECTED);
            state.subscription.removeListener("message", OnMessage);
            state.subscription.removeListener("error", OnError);
            node.error(error);
        }

        function OnDelete(error) {
            if (error != null) {
                node.error(error);
            }
            if (state.done) {
                state.done();
            }
        }

        function OnClose(done) {
            node.status(STATUS_DISCONNECTED);
            if (state.subscription) {
                state.subscription.removeListener("message", OnMessage);
                state.subscription.removeListener("error", OnError);
                if (state.autogenerated === true) {
                    state.subscription.delete(OnDelete);
                    state.done = done;
                }
                state.subscription = null;
            }
            state.topic = null;
            state.pubsub = null;
            if (state.autogenerated !== true) {
                done();
            }
        }

        function OnSubscribed(error, subscription) {
            if (error == null) {
                node.status(STATUS_CONNECTED);
                state.subscription = subscription;
                state.subscription.on("message", OnMessage);
                state.subscription.on("error", OnError);
            } else {
                node.status(STATUS_DISCONNECTED);
                node.error(error);
            }
        }

        function OnTopic(error, topic) {
            if (error == null) {
                state.topic = topic;
                var options = {};
                if (config.ackDeadlineSeconds) {
                    options.ackDeadlineSeconds = config.ackDeadlineSeconds;
                }
                if (config.encoding) {
                    options.encoding = config.encoding;
                }
                if (config.binary) {
                    options.binary = config.binary;
                }
                if (config.interval) {
                    options.interval = config.interval;
                }
                if (config.timeout) {
                    options.timeout = config.timeout;
                }
                if (config.subscription && config.subscription != "") {
                    state.autogenerated = false;
                    state.topic.subscribe(config.subscription, options, OnSubscribed);
                } else {
                    state.autogenerated = true;
                    state.topic.subscribe(options, OnSubscribed);
                }
            } else if (error.code === 409) {
                state.pubsub.topic(config.topic).get({
                    autoCreate: true
                }, OnTopic);
            } else {
                node.status(STATUS_DISCONNECTED);
                node.error(error);
            }
        }

        if (credentials) {
            state.pubsub = PubSub({
                credentials: credentials
            });
            node.status(STATUS_CONNECTING);
            state.pubsub.topic(config.topic).get({
                autoCreate: true
            }, OnTopic);
        } else {
            node.error("missing credentials");
        }

        node.on("close", OnClose);
    }
    RED.nodes.registerType("google-cloud-pubsub in", GoogleCloudPubSubInNode);

    function GoogleCloudPubSubOutNode(config) {
        RED.nodes.createNode(this, config);

        const node = this,
              credentials = GetCredentials(config.account),
              state = {
                  pubsub: null,
                  topic: null,
                  done: null,
                  pending: 0
              };

        node.status(STATUS_DISCONNECTED);

        function OnPublished(error, messageIds) {
            if (messageIds != null) {
                if (Array.isArray(messageIds)) {
                    state.pending -= messageIds.length;
                } else {
                    state.pending -= 1;
                }
            }
            if (state.pending == 0) {
                node.status(STATUS_CONNECTED);
            }
            if (error != null) {
                node.error(error);
            }
            if (state.done && state.pending == 0) {
                node.status(STATUS_DISCONNECTED);
                state.done();
            }
        }

        function OnInput(message) {
            if (message == null || !message.payload || message.payload == "")
                return;
            state.topic.publish(MqttToPubSub(message), { raw: true }, OnPublished);
            if (state.pending == 0)
                node.status(STATUS_PUBLISHING);
            state.pending += 1;
        }

        function OnClose(done) {
            state.pubsub = null;
            state.topic = null;
            node.removeListener("input", OnInput);
            if (state.pending == 0) {
                node.status(STATUS_DISCONNECTED);
                done();
            } else {
                state.done = done;
            }
        }

        function OnTopic(error, topic) {
            if (error == null) {
                state.topic = topic;
                node.status(STATUS_CONNECTED);
                node.on("input", OnInput);
            } else if (error.code === 409) {
                state.pubsub.topic(config.topic).get({
                    autoCreate: true
                }, OnTopic);
            } else {
                node.status(STATUS_DISCONNECTED);
                node.error(error);
            }
        }

        if (credentials) {
            state.pubsub = PubSub({
                credentials: credentials
            });
            node.status(STATUS_CONNECTING);
            state.pubsub.topic(config.topic).get({
                autoCreate: true
            }, OnTopic);
        } else {
            node.error("missing credentials");
        }

        node.on("close", OnClose);
    }
    RED.nodes.registerType("google-cloud-pubsub out", GoogleCloudPubSubOutNode);
}

(function() {
    "use strict";
    var _t = openerp._t;
    var _lt = openerp.web._lt;
    var QWeb = openerp.web.qweb;
    var ERROR_DELAY = 5000;
    var NBR_LIMIT_HISTORY = 20;
    var USERS_LIMIT = 20;
    var im = openerp.im = {};

    im.ConversationManager = openerp.Widget.extend({
        init: function(parent, options) {
            var self = this;
            this._super(parent);
            this.options = _.clone(options) || {};
            _.defaults(this.options, {
                inputPlaceholder: _t("Say something..."),
                defaultMessage: null,
                username: _t("Anonymous"),
                anonymous_mode: false
            });

            // business
            this.activated = true;
            this.sessions = {};

            // ui
            this.set("right_offset", 0);
            this.set("bottom_offset", 0);
            this.on("change:right_offset", this, this.calc_positions);
            this.on("change:bottom_offset", this, this.calc_positions);

            this.set("window_focus", true);
            this.set("waiting_messages", 0);
            this.on("change:waiting_messages", this, this.window_title_change);
            $(window).on("focus", _.bind(this.window_focus, this));
            $(window).on("blur", _.bind(this.window_blur, this));
            $(window).on("unload", _.bind(this.window_unload, this));
            this.window_title_change();
        },

        // TODO move to im/static/src/js/im.js openerp.im.bus
        poll: function() {
            var self = this;
            self.activated = true;
            var data = {'channels': _.keys(self.sessions)};
            console.log('poll',data);
            openerp.session.rpc("/longpolling/poll", data, {shadow: true}).then(function(result) {
                console.log('poll result', result);
                _.each(result, _.bind(self.on_notification, self));
                self.poll();
            }, function(unused, e) {
                e.preventDefault();
                self.activated = false;
                setTimeout(_.bind(self.poll, self), ERROR_DELAY);
            });
        },
        on_notification: function(notification) {

            var self = this;
            var channel = notification[0];
            var message = notification[1];
            console.log("on_notification", channel, message);
            if (message.type == "message") {
                self.received_message(channel, message);
            }
        },

        // window focus unfocus beep and title
        window_focus: function() {
            this.set("window_focus", true);
            this.set("waiting_messages", 0);
        },
        window_blur: function() {
            this.set("window_focus", false);
        },
        window_beep: function() {
            if (typeof(Audio) === "undefined") {
                return;
            }
            var audio = new Audio();
            var ext = audio.canPlayType("audio/ogg; codecs=vorbis") ? ".ogg" : ".mp3";
            var kitten = jQuery.deparam !== undefined && jQuery.deparam(jQuery.param.querystring()).kitten !== undefined;
            audio.src = openerp.session.url("/im_chat/static/src/audio/" + (kitten ? "purr" : "ting") + ext);
            audio.play();
        },
        window_title_change: function() {
            var title = undefined;
            if (! openerp.webclient || !openerp.webclient.set_title_part)
                return;
            if (this.get("waiting_messages") !== 0) {
                title = _.str.sprintf(_t("%d Messages"), this.get("waiting_messages"))
                this.window_beep();
            }
            openerp.webclient.set_title_part("im_messages", title);
        },
        window_unload: function() {
            users = new openerp.web.Model("res.users");
            return users.call("im_disconnect", [], {context: {}});
        },

        activate_session: function(session, focus) {
            var self = this;
            var conv = this.sessions[session.uuid];
            if (! conv) {
                conv = new im.Conversation(this, this, session, this.options);
                conv.appendTo($("body"));
                conv.on("destroyed", this, function() {
                    delete this.sessions[session.uuid];
                    this.calc_positions();
                });
                this.sessions[session.uuid] = conv;
                this.calc_positions();
            }
            this.trigger("im_session_activated", conv);
            if (focus)
                conv.focus();
            return conv;
        },
        received_message: function(channel, message) {
            if (! this.get("window_focus")) {
                this.set("waiting_messages", this.get("waiting_messages") + 1);
            }
            var conv = this.sessions[channel];
            conv.received_message(message);
        },
        calc_positions: function() {
            var self = this;
            var current = this.get("right_offset");
            _.each(this.sessions, function(s) {
                s.set("bottom_position", self.get("bottom_offset"));
                s.set("right_position", current);
                current += s.$().outerWidth(true);
            });
        },
        destroy: function() {
            $(window).off("unload", this.unload);
            $(window).off("focus", this.window_focus);
            $(window).off("blur", this.window_blur);
            return this._super();
        }
    });

    im.Conversation = openerp.Widget.extend({
        className: "openerp_style oe_im_chatview",
        events: {
            "keydown input": "keydown",
            "click .oe_im_chatview_close": "close",
            "click .oe_im_chatview_header": "show_hide"
        },
        init: function(parent, c_manager, session, options) {
            this._super(parent);
            this.c_manager = c_manager;
            this.options = options || {};
            this.session = session;
            this.set("right_position", 0);
            this.set("bottom_position", 0);
            this.shown = true;
            this.set("pending", 0);
            this.inputPlaceholder = this.options.defaultInputPlaceholder;
            this.set("users", []);
            this.others = [];
        },
        start: function() {
            var self = this;
            self.$().append(openerp.qweb.render("im.Conversation", {widget: self}));
            this.$().hide();
            self.on("change:right_position", self, self.calc_pos);
            self.on("change:bottom_position", self, self.calc_pos);
            self.full_height = self.$().height();
            self.calc_pos();
            self.on("change:pending", self, _.bind(function() {
                if (self.get("pending") === 0) {
                    self.$(".oe_im_chatview_nbr_messages").text("");
                } else {
                    self.$(".oe_im_chatview_nbr_messages").text("(" + self.get("pending") + ")");
                }
            }, self));
            self.$().show();
        },
        show_hide: function() {
            if (this.shown) {
                this.$().animate({
                    height: this.$(".oe_im_chatview_header").outerHeight()
                });
            } else {
                this.$().animate({
                    height: this.full_height
                });
            }
            this.shown = ! this.shown;
            if (this.shown) {
                this.set("pending", 0);
            }
        },
        calc_pos: function() {
            this.$().css("right", this.get("right_position"));
            this.$().css("bottom", this.get("bottom_position"));
        },
        received_message: function(message) {
            if (this.shown) {
                this.set("pending", 0);
            } else {
                this.set("pending", this.get("pending") + 1);
            }
            console.log('recv',message);
            //this._add_bubble(message.from_id, message.message, openerp.str_to_datetime(message.date));
            this._add_bubble(message.from_id, message.message, new Date());
        },
        keydown: function(e) {
            if(e && e.which !== 13) {
                return;
            }
            var mes = this.$("input").val();
            if (! mes.trim()) {
                return;
            }
            this.$("input").val("");
            this.send_message(mes);
        },
        send_message: function(message) {
            var self = this;
            var send_it = function() {
                return openerp.session.rpc("/im/post", {uuid: self.session.uuid, message_type: "message", message_content: message});
            };
            var tries = 0;
            send_it().fail(function(error, e) {
                e.preventDefault();
                tries += 1;
                if (tries < 3)
                    return send_it();
            });
        },
        escape_keep_url: function(str){
            var url_regex = /(ftp|http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?/gi;
            var last = 0;
            var txt = "";
            while (true) {
                var result = url_regex.exec(str);
                if (! result)
                    break;
                txt += _.escape(str.slice(last, result.index));
                last = url_regex.lastIndex;
                var url = _.escape(result[0]);
                txt += '<a href="' + url + '" target="_blank">' + url + '</a>';
            }
            txt += _.escape(str.slice(last, str.length));
            return txt;
        },
        _add_bubble: function(user, item, date) {
            var items = [item];
            if (user === this.last_user) {
                this.last_bubble.remove();
                items = this.last_items.concat(items);
            }
            this.last_user = user;
            this.last_items = items;
            var zpad = function(str, size) {
                str = "" + str;
                return new Array(size - str.length + 1).join('0') + str;
            };
            date = "" + zpad(date.getHours(), 2) + ":" + zpad(date.getMinutes(), 2);
            var to_show = _.map(items, this.escape_keep_url);
            var img = openerp.session.url('/im/image', {uuid: this.session.uuid, user_id: user});
            this.last_bubble = $(openerp.qweb.render("im.Conversation_bubble", {"items": to_show, "user": user, "time": date, 'avatar_url': img}));
            this.$(".oe_im_chatview_content").append(this.last_bubble);
            this._go_bottom();
        },
        _go_bottom: function() {
            this.$(".oe_im_chatview_content").scrollTop($(this.$(".oe_im_chatview_content").children()[0]).height());
        },
        add_user: function(user) {
            if (user === this.me || _.contains(this.get("users"), user))
                return;
            im_common.connection.model("im.session").call("add_to_session",
                    [this.session_id, user.get("id"), this.c_manager.me.get("uuid")]).then(_.bind(function() {
                this.send_message(JSON.stringify({"type": "session_modified", "action": "added", "user_id": user.get("id")}), true);
            }, this));
        },
        focus: function() {
            this.$(".oe_im_chatview_input").focus();
            if (! this.shown)
                this.show_hide();
        },
        close: function() {
            var def = $.when();
            if (this.get("users").length > 1) {
                def = im_common.connection.model("im.session").call("remove_me_from_session",
                        [this.session_id, this.c_manager.me.get("uuid")]).then(_.bind(function() {
                    return this.send_message(JSON.stringify({"type": "session_modified", "action": "removed",
                        "user_id": this.c_manager.me.get("id")}), true)
                }, this))
            }

            return def.then(_.bind(function() {
                this.destroy();
            }, this));
        },
        destroy: function() {
            this.trigger("destroyed");
            return this._super();
        }
    });

    im.UserWidget = openerp.web.Widget.extend({
        "template": "im.UserWidget",
        events: {
            "click": "activate_user",
        },
        init: function(parent, user) {
            this._super(parent);
            this.user = user;
        },
        start: function() {
            this.$el.data("user", this.user);
            this.$el.draggable({helper: "clone"});

            this.$(".oe_im_user_online").toggle(this.user.im_status === true);
        },
        activate_user: function() {
            this.trigger("activate_user", this.user);
        },
    });

    im.InstantMessaging = openerp.web.Widget.extend({
        template: "im.InstantMessaging",
        events: {
            "keydown .oe_im_searchbox": "input_change",
            "keyup .oe_im_searchbox": "input_change",
            "change .oe_im_searchbox": "input_change",
        },
        init: function(parent) {
            this._super(parent);
            this.shown = false;
            this.set("right_offset", 0);
            this.set("current_search", "");
            this.users = [];
            this.widgets = [];
            this.c_manager = new openerp.im.ConversationManager(this);
            this.on("change:right_offset", this.c_manager, _.bind(function() {
                this.c_manager.set("right_offset", this.get("right_offset"));
            }, this));
            this.user_search_dm = new openerp.web.DropMisordered();
        },
        start: function() {
            var self = this;
            this.$el.css("right", -this.$el.outerWidth());
            $(window).scroll(_.bind(this.calc_box, this));
            $(window).resize(_.bind(this.calc_box, this));
            this.calc_box();

            this.on("change:current_search", this, this.search_changed);
            this.search_changed();

            // add a drag & drop listener
            self.c_manager.on("im_session_activated", self, function(conv) {
                conv.$el.droppable({
                    drop: function(event, ui) {
                        conv.add_user(ui.draggable.data("user").id);
                    }
                });
            });
            // add a listener for the update of users status
            self.c_manager.on("im_new_user_status", self, this.update_users_status);

            self.c_manager.poll();
            return;
        },
        calc_box: function() {
            var $topbar = openerp.client.$(".navbar");
            var top = $topbar.offset().top + $topbar.height();
            top = Math.max(top - $(window).scrollTop(), 0);
            this.$el.css("top", top);
            this.$el.css("bottom", 0);
        },
        input_change: function() {
            this.set("current_search", this.$(".oe_im_searchbox").val());
        },
        search_changed: function(e) {
            var user_model = new openerp.web.Model("res.users");
            var self = this;
            return this.user_search_dm.add(user_model.call("im_search", [this.get("current_search"), 
                        USERS_LIMIT], {context:new openerp.web.CompoundContext()})).then(function(result) {
                self.$(".oe_im_input").val("");
                var old_widgets = self.widgets;
                self.widgets = [];
                self.users = [];
                _.each(result, function(user) {
                    user.image_url = openerp.session.url('/web/binary/image', {model:'res.users', field: 'image_small', id: user.id});
                    var widget = new openerp.im.UserWidget(self, user);
                    widget.appendTo(self.$(".oe_im_users"));
                    widget.on("activate_user", self, self.activate_user);
                    self.widgets.push(widget);
                    self.users.push(user);
                });
                _.each(old_widgets, function(w) {
                    w.destroy();
                });
            });
        },
        switch_display: function() {
            var fct =  _.bind(function(place) {
                this.set("right_offset", place + this.$el.outerWidth());
            }, this);
            var opt = {
                step: fct,
            };
            if (this.shown) {
                this.$el.animate({
                    right: -this.$el.outerWidth(),
                }, opt);
            } else {
                if (! this.c_manager.activated) {
                    this.do_warn("Instant Messaging is not activated on this server. Try later.", "");
                    return;
                }
                this.$el.animate({
                    right: 0,
                }, opt);
            }
            this.shown = ! this.shown;
        },
        activate_user: function(user) {
            var self = this;
            var sessions = new openerp.web.Model("im.session");
            return sessions.call("session_get", [user.id]).then(function(session) {
               self.c_manager.activate_session(session, true);
            });
        },
        update_users_status: function(users_list){
            _.each(users_list, function(el) {
                $('img[data-im-user-id='+el.id+']').toggle(!! el.im_status)
            });
        }
    });

    im.ImTopButton = openerp.web.Widget.extend({
        template:'im.ImTopButton',
        events: {
            "click": "clicked",
        },
        clicked: function() {
            this.trigger("clicked");
        },
    });

    openerp.web.UserMenu.include({
        do_update: function(){
            var self = this;
            this.update_promise.then(function() {
                var im = new openerp.im.InstantMessaging(self);
                openerp.im.single = im;
                im.appendTo(openerp.client.$el);
                var button = new openerp.im.ImTopButton(this);
                button.on("clicked", im, im.switch_display);
                button.appendTo(openerp.webclient.$el.find('.oe_systray'));
            });
            return this._super.apply(this, arguments);
        },
    });

    return im;
})();

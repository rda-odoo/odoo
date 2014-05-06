(function(){

    "use strict";
    var _t = openerp._t;
    var _lt = openerp._lt;
    var QWeb = openerp.qweb;
    var NBR_LIMIT_HISTORY = 20;
    var USERS_LIMIT = 20;
    var im_chat = openerp.im_chat = {};

    im_chat.ConversationManager = openerp.Widget.extend({
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
            this.sessions = {};
            this.bus = openerp.im.bus;
            this.bus.on("notification", this, this.on_notification);
            this.bus.options["im_presence"] = true;

            // ui
            this.set("right_offset", 0);
            this.set("bottom_offset", 0);
            this.on("change:right_offset", this, this.calc_positions);
            this.on("change:bottom_offset", this, this.calc_positions);

            this.set("window_focus", true);
            this.on("change:window_focus", self, function(e) {
                self.bus.options["im_presence"] = self.get("window_focus");
            });
            this.set("waiting_messages", 0);
            this.on("change:waiting_messages", this, this.window_title_change);
            $(window).on("focus", _.bind(this.window_focus, this));
            $(window).on("blur", _.bind(this.window_blur, this));
            this.window_title_change();
        },
        on_notification: function(notification) {
            var self = this;
            var channel = notification[0];
            var message = notification[1];

            var regex_uuid = new RegExp(/(\w{8}(-\w{4}){3}-\w{12}?)/g);

            console.log('ON NOTIF', JSON.stringify(notification));

            // Concern im_chat : if the channel is the im_chat.session or im_chat.status, or a 'private' channel (aka the UUID of a session)
            if((Array.isArray(channel) && (channel[1] === 'im_chat.session' || channel[1] === 'im_chat.presence')) || (regex_uuid.test(channel))){
                // message to display in the chatview
                if (message.type == "message") {
                    self.received_message(message);
                }
                // activate the received session
                if(message.uuid){
                    this.activate_session(message);
                }
                // user status notification
                if(message.im_status){
                    self.trigger("im_new_user_status", [message]);
                }
            }

           /* if(Array.isArray(channel)){
                if(channel[1] === 'im_chat.session'){
                    // message
                }else if(channel[1] === 'im_chat.presence'){
                    // status message
                }
            }
            */

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

        activate_session: function(session, focus) {
            console.log("activate session ");
            var self = this;
            var conv = this.sessions[session.uuid];
            if (! conv) {
                conv = new im_chat.Conversation(this, this, session, this.options);
                conv.appendTo($("body"));
                conv.on("destroyed", this, function() {
                    delete this.sessions[session.uuid];
                    this.calc_positions();
                });
                this.sessions[session.uuid] = conv;
                this.calc_positions();
            }else{
                conv.set("session", session);
            }
            this.trigger("im_session_activated", conv);
            if (focus)
                conv.focus();
            return conv;
        },
        received_message: function(message) {
            var self = this;
            var session_id = message.to_id[0];
            var uuid = message.to_id[1];
            if (! this.get("window_focus")) {
                this.set("waiting_messages", this.get("waiting_messages") + 1);
            }
            var conv = this.sessions[uuid];
            //console.log("received_message conv = ", conv);
            if(!conv){
                // fetch the session, and init it with the message
                var def_session = new openerp.web.Model("im_chat.session").call("session_info", [], {"ids" : [session_id]}).then(function(session){
                    conv = self.activate_session(session, false);
                    conv.received_message(message);
                });
            }else{
                conv.received_message(message);
            }
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

    im_chat.Conversation = openerp.Widget.extend({
        className: "openerp_style oe_im_chatview",
        events: {
            "keydown input": "keydown",
            "click .oe_im_chatview_close": "close",
            "click .oe_im_chatview_header": "click_header"
        },
        init: function(parent, c_manager, session, options, init_messages) {
            this._super(parent);
            this.c_manager = c_manager;
            this.options = options || {};
            this.init_messages = init_messages || [];
            this.first_message_id = Number.MAX_VALUE;
            this.last_message_id = 0;
            this.loading_history = !this.options["anonymous_mode"];
            this.message = {};
            this.set("session", session);
            this.set("right_position", 0);
            this.set("bottom_position", 0);
            this.shown = true;
            this.set("pending", 0);
            this.inputPlaceholder = this.options.defaultInputPlaceholder;
        },
        start: function() {
            var self = this;
            self.$().append(openerp.qweb.render("im_chat.Conversation", {widget: self}));
            self.$().hide();
            self.on("change:session", self, self.update_session);
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
            self.$('.oe_im_chatview_content').on('scroll',function(){
                if($(this).scrollTop() === 0){
                    self.load_history();
                }
            });
            // prepare the header and the correcte state
            // TODO : maybe this need to be called after self.$().show()
            self.update_session();
            // init with init_messages, then load history (to avoid duplicate)
            _.each(self.init_messages, function(m){
                self.received_message(m);
            });
            //this.load_history();
            self.$().show();
            /*
            if(this.get("session").state && this.get("session").state !== 'open'){
                this.$().height(this.$(".oe_im_chatview_header").outerHeight());
                this.shown = false;
            }
            */
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
        click_header: function(){
            this.update_fold_state(this.shown ? 'folded' : 'open');
        },
        update_fold_state: function(state){
            if(!this.options["anonymous_mode"]){
                return new openerp.Model("im_chat.session").call("update_state", [this.get("session").uuid, state]);
            }
        },
        calc_pos: function() {
            this.$().css("right", this.get("right_position"));
            this.$().css("bottom", this.get("bottom_position"));
        },
        update_session: function(){
            // built the name
            var names = [];
            _.each(this.get("session").users, function(user){
                if(openerp.session.uid != user.id){
                    names.push(user.name);
                }
            });
            this.$(".oe_im_chatview_header_name").text(names.length ? names.join(", ") : this.get("session").name);
            // update the fold state
            if(this.get("session").state){
                if(this.get("session").state === 'closed'){
                    this.destroy();
                }else{
                    if((this.get("session").state === 'open' && !this.shown) || (this.get("session").state === 'folded' && this.shown)){
                        this.show_hide();
                    }
                }
            }
        },
        load_history: function(){
            var self = this;
                if(this.loading_history){
                    var domain = [["to_id.uuid", "=", this.get("session").uuid]];
                    if(this.first_message_id !== Number.MAX_VALUE){
                        domain.push(['id','<',this.first_message_id]);
                    }
                    new openerp.web.Model("im_chat.message").call("search_read", [domain, ['id', 'date','to_id','from_id', 'type', 'message'], 0, NBR_LIMIT_HISTORY]).then(function(messages){
                        messages.reverse();
                        if(messages.length > 0){
                            self._preprend_messages(messages);
                        }
                        if(messages.length != NBR_LIMIT_HISTORY){
                            self.loading_history = false;
                        }
                    });
                }
        },
        received_message: function(message) {
            if(this.last_message_id < message.id){
                if (this.shown) {
                    this.set("pending", 0);
                } else {
                    this.set("pending", this.get("pending") + 1);
                }
                message.session && this.set("session", message.session);
                this._append_messages([message]);
            }
        },
        send_message: function(message, type) {
            var self = this;
            var send_it = function() {
                return openerp.session.rpc("/im/post", {uuid: self.get("session").uuid, message_type: type, message_content: message});
            };
            var tries = 0;
            send_it().fail(function(error, e) {
                e.preventDefault();
                tries += 1;
                if (tries < 3)
                    return send_it();
            });
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
            this.send_message(mes, "message");
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
        _append_messages: function(messages){
            console.log(" ########## APPEND : "+JSON.stringify(messages.length));
            var self = this;
            this.last_message_id = _.last(messages).id;
            this.first_message_id = _.min([this.first_message_id, _.first(messages).id]);

            var bubbles = this._build_bubbles(messages, this.last_bubble);
            _.each(bubbles, function(b){
                self.$(".oe_im_chatview_content").append(b);
            });
            this.last_bubble = _.last(bubbles);
            this._go_bottom();
        },
        _preprend_messages: function(messages){
            console.log(" ########### PREPEND : "+JSON.stringify(messages.length));
            var self = this;
            this.first_message_id = _.min([this.first_message_id, _.first(messages).id]);

            var bubbles = this._build_bubbles(messages);
            bubbles.reverse();
            _.each(bubbles, function(b){
                self.$(".oe_im_chatview_content").prepend(b);
            });
        },
        _build_bubbles: function(messages, last_b){
            var zpad = function(str, size) {
                str = "" + str;
                return new Array(size - str.length + 1).join('0') + str;
            };
            var bubbles = [];
            last_b && bubbles.push(last_b);
            for (var i=0; i < messages.length; i++){
                var current = messages[i];

                // insert a date bubble if needed
                var date = openerp.str_to_datetime(current.date);
                //var date_hours = "" + zpad(date.getHours(), 2) + ":" + zpad(date.getMinutes(), 2);
                var date_hours = "";
                current.date = "a b";
                var date_day = current.date.split(" ")[0];
                if(!_.last(bubbles) || _.last(bubbles).data("date_day") != date_day){
                    var bubble_date = $(openerp.qweb.render("im_chat.Conversation_date_separator", {"date": date_day}));
                    bubbles.push(bubble_date);
                }
                // append or create new bubble for the message
                if(current.type == "message"){ // traditionnal message
                    if(_.last(bubbles) && _.last(bubbles).data("user_id") === current.from_id[0]){
                        // append to the list of item of the bubble
                        var item = $('<div></div>').text(this.escape_keep_url(current.message)).addClass("oe_im_chatview_bubble_item");
                        _.last(bubbles).find('.oe_im_chatview_bubble_list').append(item);
                        _.last(bubbles).find('.oe_im_chatview_time').text(date_hours);
                    }else{
                        // create a new bubble
                        var to_show = this.escape_keep_url(current.message);
                        var img = openerp.session.url('/im/image', {uuid: this.get('session').uuid, user_id: current.from_id[0]});
                        var bubble_tmp = $(openerp.qweb.render("im_chat.Conversation_bubble", {"items": [to_show], "user": current.from_id, "time": date_hours, 'avatar_url': img}));
                        bubble_tmp.data("user_id", current.from_id[0]);
                        bubble_tmp.data("date_day", date_day);
                        bubbles.push(bubble_tmp);
                    }
                }else{ // technical message
                    // create new bubble and set no data attributes
                    switch (current.type) {
                        case "add_user":
                            var user_info = JSON.parse(current.message);
                            var tech_mess = user_info["user_name"] + _t(" was invited by ") + current.from_id[1];
                            var bubble_tmp = $(openerp.qweb.render("im_chat.Conversation_technical_bubble", {"technical_message": tech_mess, "time": date_hours}));
                            bubble_tmp.data("date_day", date_day);
                            bubbles.push(bubble_tmp);
                            break;
                        case "invitation":
                            break;
                    }
                }
            }
            return bubbles;
        },
        _go_bottom: function() {
            this.$(".oe_im_chatview_content").scrollTop(this.$(".oe_im_chatview_content").get(0).scrollHeight);
        },
        add_user: function(user){
            var content = JSON.stringify({"user_id" : user.id, "user_name": user.name});
            this.send_message(content, "add_user");
        },
        focus: function() {
            this.$(".oe_im_chatview_input").focus();
            if (! this.shown)
                this.show_hide();
        },
        close: function(event) {
            event.stopPropagation();
            this.update_fold_state('closed');
            /*
            return def.then(_.bind(function() {
                this.destroy();
            }, this));
*/
        },
        destroy: function() {
            this.trigger("destroyed");
            return this._super();
        }
    });

    im_chat.UserWidget = openerp.Widget.extend({
        "template": "im_chat.UserWidget",
        events: {
            "click": "activate_user",
        },
        init: function(parent, user) {
            this._super(parent);
            this.set("id", user.id);
            this.set("name", user.name);
            this.set("im_status", user.im_status);
            this.set("image_url", user.image_url);
        },
        start: function() {
            this.$el.data("user", {id:this.get("id"), name:this.get("name")});
            this.$el.draggable({helper: "clone"});
            this.on("change:im_status", this, this.update_status);
            this.update_status();
        },
        update_status: function(){
            this.$(".oe_im_user_online").toggle(this.get('im_status') !== 'offline');
            var img_src = (this.get('im_status') == 'away' ? '/im_chat/static/src/img/yellow.png' : '/im_chat/static/src/img/green.png');
            this.$(".oe_im_user_online").attr('src', openerp.session.server + img_src);
        },
        activate_user: function() {
            this.trigger("activate_user", this.get("id"));
        },
    });

    im_chat.InstantMessaging = openerp.Widget.extend({
        template: "im_chat.InstantMessaging",
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
            this.widgets = {};

            this.c_manager = new openerp.im_chat.ConversationManager(this);
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
                        conv.add_user(ui.draggable.data("user"));
                    }
                });
            });
            // add a listener for the update of users status
            this.c_manager.on("im_new_user_status", this, this.update_users_status);

            // fetch the unread message and the recent activity (e.i. to re-init in case of refreshing page)
            openerp.session.rpc("/im/init",{}).then(function(notifications) {
                _.each(notifications, function(notif){
                    console.log("==========================");
                    self.c_manager.on_notification(notif);
                });
                // start polling
                openerp.im.bus.poll();
            });
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
                self.widgets = {};
                self.users = [];
                _.each(result, function(user) {
                    user.image_url = openerp.session.url('/web/binary/image', {model:'res.users', field: 'image_small', id: user.id});
                    var widget = new openerp.im_chat.UserWidget(self, user);
                    widget.appendTo(self.$(".oe_im_users"));
                    widget.on("activate_user", self, self.activate_user);
                    self.widgets[user.id] = widget;
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
                 if (! openerp.im.bus.activated) {
                    this.do_warn("Instant Messaging is not activated on this server. Try later.", "");
                    return;
                }
                this.$el.animate({
                    right: 0,
                }, opt);
            }
            this.shown = ! this.shown;
        },
        activate_user: function(user_id) {
            var self = this;
            var sessions = new openerp.web.Model("im_chat.session");
            return sessions.call("session_get", [user_id]).then(function(session) {
               self.c_manager.activate_session(session, true);
            });
        },
        update_users_status: function(users_list){
            var self = this;
            _.each(users_list, function(el) {
                self.widgets[el.id] && self.widgets[el.id].set("im_status", el.im_status);
            });
        }
    });

    im_chat.ImTopButton = openerp.Widget.extend({
        template:'im_chat.ImTopButton',
        events: {
            "click": "clicked",
        },
        clicked: function() {
            this.trigger("clicked");
        },
    });

    if(openerp.web && openerp.web.UserMenu) {
    openerp.web.UserMenu.include({
        do_update: function(){
            var self = this;
            this.update_promise.then(function() {
                var im = new openerp.im_chat.InstantMessaging(self);
                openerp.im_chat.single = im;
                im.appendTo(openerp.client.$el);
                var button = new openerp.im_chat.ImTopButton(this);
                button.on("clicked", im, im.switch_display);
                button.appendTo(openerp.webclient.$el.find('.oe_systray'));
            });
            return this._super.apply(this, arguments);
        },
    });
    }

    return im_chat;
})();

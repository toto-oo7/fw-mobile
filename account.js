/* Supabase JS 2.118.0 负责会话保存、跨标签页通知和令牌刷新。 */
(function (global) {
  'use strict';
  var cfg = global.FW_CLOUD_CONFIG || {};
  var client = null, user = null, listeners = [], recovering = false;
  var ready = Promise.resolve();
  function message(error) {
    var code = error && error.code;
    var messages = {
      invalid_credentials: '邮箱或密码不正确，请重新输入。',
      email_not_confirmed: '请先打开注册邮件确认邮箱，再登录。',
      user_already_exists: '这个邮箱已注册，请登录或找回密码。',
      weak_password: '密码强度不足，请使用更长的密码。',
      over_email_send_rate_limit: '邮件发送太频繁，请稍后再试。',
      email_address_not_authorized: '邮件服务尚未开放，请联系管理员配置发信服务。',
      signup_disabled: '注册暂未开放，请联系管理员。',
      session_not_found: '登录已过期，请重新登录。'
    };
    return messages[code] || (/fetch|network/i.test(String(error && error.message))
      ? '暂时连不上账号服务，请检查网络后重试。'
      : '操作未完成：' + String(error && error.message || error || '请稍后重试'));
  }
  function checked(result) {
    if (result.error) throw new Error(message(result.error));
    return result.data;
  }
  function configured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.url || '') &&
      /^sb_publishable_/.test(cfg.publishableKey || '');
  }
  function requireClient() {
    if (!client) throw new Error('账号服务尚未配置，现有本机功能仍可使用。');
    return client;
  }
  function publish(event, session) {
    user = session && session.user || null;
    if (event === 'PASSWORD_RECOVERY') recovering = true;
    listeners.forEach(function (fn) { fn(user, event); });
  }
  if (configured() && global.supabase) {
    client = global.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { storageKey: 'fw.auth.v1', persistSession: true, autoRefreshToken: true,
        detectSessionInUrl: true, flowType: 'implicit' }
    });
    client.auth.onAuthStateChange(function (event, session) {
      // 回调内不调用异步 Auth 方法，避免 SDK 的会话锁死锁。
      publish(event, session);
    });
    ready = client.auth.getSession().then(function (result) {
      var data = checked(result);
      user = data.session && data.session.user || null;
    });
  }
  function redirect() { return location.origin + location.pathname; }
  global.Account = {
    ready: ready, configured: configured,
    current: function () { return user; },
    recovering: function () { return recovering; },
    subscribe: function (fn) { listeners.push(fn); },
    signIn: function (email, password) {
      return requireClient().auth.signInWithPassword({ email: email, password: password }).then(checked);
    },
    signUp: function (email, password) {
      return requireClient().auth.signUp({ email: email, password: password,
        options: { emailRedirectTo: redirect() } }).then(checked);
    },
    recover: function (email) {
      return requireClient().auth.resetPasswordForEmail(email, { redirectTo: redirect() }).then(checked);
    },
    updatePassword: function (password) {
      return requireClient().auth.updateUser({ password: password }).then(checked).then(function (data) {
        recovering = false; return data;
      });
    },
    signOut: function () {
      return requireClient().auth.signOut({ scope: 'local' }).then(checked);
    },
    merge: function (records, expectedId) {
      var c = requireClient();
      return c.auth.getSession().then(function (result) {
        var data = checked(result);
        if (!data.session || data.session.user.id !== expectedId) throw new Error('账号已改变，请重新同步。');
        // 固定这次请求的令牌，异步同步不能借用后来登录的另一个账号。
        return fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/rpc/fw_merge_records', {
          method: 'POST', cache: 'no-store', headers: {
            apikey: cfg.publishableKey, Authorization: 'Bearer ' + data.session.access_token,
            'Content-Type': 'application/json'
          }, body: JSON.stringify({ incoming: records })
        });
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            if (response.status === 401) throw new Error('登录已过期，请重新登录。');
            if (data.code === 'PGRST202') throw new Error('云端数据库尚未配置，请联系管理员。');
            throw new Error('云端同步失败，请稍后重试（' + response.status + '）。');
          }
          if (!data || !data.records || data.schema !== 1) throw new Error('云端返回的数据格式不正确，未覆盖本机内容。');
          return data.records;
        });
      });
    }
  };
})(window);

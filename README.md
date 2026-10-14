# Aliyun Role Switch

阿里云控制台一键切换 RAM 角色的油猴脚本。在任意控制台页面左下角点一下，就能切换到预先配置的角色，再点一下切回登录身份，不用再进「切换身份」页面手动填写。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) (不支持 Greasemonkey 4)
2. 打开 [aliyun-role-switch.user.js](https://raw.githubusercontent.com/BlackHole1/aliyun-role-switch/main/aliyun-role-switch.user.js)，按提示安装

## 使用

1. 打开任意阿里云控制台页面，点左下角「配置切换身份」(或脚本管理器菜单里的「设置切换身份」)
2. 填入要切换的主账号 UID (或企业别名、默认域名) 和角色名，和控制台「切换身份」页面填的内容一致，可以配置多个
3. 之后左下角按钮:
   - 直接点击: 在当前页切换，完成后刷新
   - Command (Windows 上是 Ctrl) 加点击: 切换后在新标签页打开当前地址
   - 配置了多个身份时，点按钮会先弹出身份列表
   - 当前是角色身份时，按钮变成「返回登录身份」

配置只保存在本机的脚本管理器里。

## 原理

切换接口的请求带有阿里云防机器人脚本实时生成的参数，无法在别处直接调用。脚本在隐藏 iframe 里加载官方「切换身份」页面并自动提交，同时拦截页面的请求结果，提前写好会话 cookie，省掉官方页面的跳转等待。鼠标移到按钮上时才预加载切换页面，不会在每次打开控制台时多发请求。

如果阿里云要求人机验证，请用控制台右上角的「切换身份」手动切换一次。

## License

[MIT](LICENSE)

# ZENZO Forge REST API

## 基本事項
**説明:** これは、ZENZO Forge REST APIがどのように機能するか、および[Postman](https://www.getpostman.com/downloads/)を使用してAPIと対話する基本についてのガイドです。

Forge REST APIは `POST` HTTPリクエストを使用していますが、一部のエンドポイントは公開認証されていません。他のエンドポイントは非公開であり、Forgeノードが再起動するたびにランダムに生成される「auth」トークンが必要になります。




## 環境のセットアップ
1. [ZENZO Forge](https://github.com/ZENZO-Ecosystem/zenzo-forge/releases)の最新バージョンが実行されていることを確認してください。
2. [Postman](https://www.getpostman.com/downloads/)をダウンロードします。
3. Postmanを実行してセットアップします。**「New」**、**「Request」**の順にクリックし、次に**「GET」**を**「POST」**に設定して、**「Content-Type」**を**"application / x-www-form-urlencoded"**のように追加します。 。
4. ルートホストをエンドポイントに追加します。（ほとんどの場合、`http：// localhost`を追加することになります）




## APIの使い方
まず、呼び出すAPI **エンドポイント(Endpoint)**を決める必要があります。たとえば、`/ forge / items`は"Forge Items"エンドポイントを呼び出し、既知のすべてのZENZO Forgeアイテム（ZFI）のリストを返します。

一部のAPIでは、**Body Key(ボディキー)**やプロパティなどの追加情報が必要になります。**「Body 」**タブで`x-www-form-urlencoded`のオプションをオンにすると、ボディのプロパティを追加/削除できます。

たとえば、`/ forge / smelt`エンドポイントを使用するには、**「auth」**および**「hash」**キーが必要です。「auth」は、ローカルのForgeノード（デバッグコンソールにあります）によって生成された公開鍵であり、「hash」キーは、精錬したいアイテムのトランザクションIDです。




## エンドポイントリスト

### :unlock:**公開API（認証は不要）**

#### ZENZO Forge Items 
> ネットワーク上にある**すべての**（既知の）アイテムのリストを返します
- エンドポイント: `/forge/items`

#### ZENZO Forge Inventory 
> ローカルノードが所有するアイテムのリストを返します。例：ノードのインベントリ
- エンドポイント: `/forge/inventory`

#### ZENZO Forge Profiles 
> ネットワーク上にある**すべての**（既知の）ZENZOプロファイルのリストを返します
- エンドポイント: `/forge/profiles`

#### ZENZO Forge Profile 
> **Username**または**Address**で単一のプロファイルを返します
- エンドポイント: `/forge/profile`
- ボディキー "name": (text形式、検索するプロファイルの名前またはアドレス)

### :lock:**非公開API (認証が必要)**

:warning:**警告：ローカル環境でのみ使用してください！認証キーが公開されている場合、あなたの資産は深刻なリスクにさらされてしまいます。** 

### Account 
> ノードとそのユーザーの一般情報を返します：アドレス、残高、ウォレットのバージョンなど
- エンドポイント: `/forge/account`

ボディキー | 形式 | 説明
------------ | ------------- | -------------
auth | text | ノードによって生成された認証キー

### Create 
> アイテム、およびカスタムZENZO Forgeアイテムの作成
- エンドポイント: `/forge/create`

ボディキー | 形式 | 説明
------------ | ------------- | -------------
auth | text | ノードによって生成された認証キー
name | text | アイテムの表示名（1〜50文字に設定する必要があります）
image | text | アイテムの画像のURL（空白にすることはできません。デフォルトのアイテムカバーには「default」を使用してください）
amount | number | アイテムのZNZでの値（0.01 ZNZ以上を設定しなければなりません）
metadata | custom | アイテムに2KBのカスタムデータを保存できます（2KBを超えるデータは保存できません）
contract | JSON obj | キーは各コントラクトの名前、プロパティはコントラクトの内容です（1KB以内にする必要があります）

### Transfer 
> アイテムを別のアドレスに転送します
- エンドポイント: `/forge/transfer`

ボディキー | 形式 | 説明
------------ | ------------- | -------------
auth | text | ノードによって生成された認証キー
item | text | 転送するアイテムのトランザクションID
to | text | アイテムを転送するアドレス

### Smelt 
> アイテムを精錬する、または破壊（リソースに戻す）して、ZNZで裏付けされた値をユーザーに返します
Smelts an item, destroying it and returning the ZNZ-backed value to the user)
- エンドポイント: `/forge/smelt`

ボディキー | 形式 | 説明
------------ | ------------- | -------------
auth | text | ノードによって生成された認証キー
hash | text | 精錬するアイテムのトランザクションID
